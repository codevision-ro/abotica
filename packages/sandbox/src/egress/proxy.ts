/**
 * Egress proxy for sandbox containers. Containers sit on an internal network with no route out; the
 * only way out is this proxy, which the worker runs on its address in that network. Plain HTTP goes
 * through as absolute-URI requests, everything else (HTTPS, git, ssh over 443) through CONNECT.
 *
 * Each exec gets a random token (sent as the proxy username) that maps to its egress list, only
 * works from the address of the container it was issued to (a token read from another workspace's
 * environment is useless) and dies with the exec. A request is allowed when the host matches the list, then the name is resolved once,
 * blocked addresses are dropped and the proxy connects to a vetted address, so a second lookup cannot
 * swap in a private one. Refusals carry a short plain-text reason, in the status line and the body,
 * because the agent reads it from the client's error message.
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Egress } from "../types";
import { addressKey, isBlockedAddress, localAddresses, parseIPv4 } from "./addresses";
import { matchesEgress, normalizeHost, parseAuthority } from "./policy";

export const EGRESS_PROXY_PORT = 3128;

export type EgressProxyOptions = {
  /** Address to listen on: the worker's address in the sandbox network. */
  host: string;
  /** Default 3128; 0 picks a free port. */
  port?: number;
  /** Resolving and connecting upstream, default 10 s. */
  connectTimeoutMs?: number;
  /** A connection with no traffic either way is closed after this long, default 10 min. */
  idleTimeoutMs?: number;
  /** Concurrent upstream connections per token, default 64. */
  maxConnectionsPerToken?: number;
  /** Tests only: allow loopback upstreams so local test servers are reachable. */
  unsafeAllowLoopback?: boolean;
  /** Name resolution, default dns.lookup (all addresses). Tests use it to control timing. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
};

export type EgressGrant = {
  readonly token: string;
  /**
   * `http://<token>:x@<host>:<port>`, for HTTP_PROXY and HTTPS_PROXY. The password is a placeholder:
   * git and pip treat a username without one as incomplete and prompt or drop the credentials.
   */
  readonly url: string;
  /** Forgets the token and closes its open connections. Idempotent. */
  revoke(): void;
};

export type EgressProxy = {
  readonly host: string;
  readonly port: number;
  /** Registers a token for one exec, usable only from `client` (the container's address). */
  register(egress: Egress, client: string): EgressGrant;
  close(): Promise<void>;
};

type GrantState = { egress: Egress; client: string; active: number; sockets: Set<Duplex>; revoked: boolean };

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(reason);
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

const AUTH_REQUIRED = new Refusal(407, "Proxy authentication required: use the HTTP_PROXY settings of the sandbox", {
  "proxy-authenticate": 'Basic realm="abotica-sandbox"',
});

/** Strips hop-by-hop headers, including the ones a Connection header names. */
function endToEndHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !named.has(name)) out[name] = value;
  }
  return out;
}

/** Token from `Proxy-Authorization: Basic base64(token:password)`; the password is ignored. */
function tokenFrom(header: string | undefined): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const token = decoded.split(":")[0] ?? "";
  return token || null;
}

// Status line reasons must stay on one line of printable ASCII.
const reasonPhrase = (reason: string) => reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

function writeRefusal(socket: Duplex, refusal: Refusal) {
  const body = `${refusal.reason}\n`;
  const headers = Object.entries({
    ...refusal.headers,
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    connection: "close",
  })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(`HTTP/1.1 ${refusal.status} ${reasonPhrase(refusal.reason)}\r\n${headers}\r\n${body}`);
  // Server sockets allow half-open connections; do not wait for the client to hang up.
  socket.once("finish", () => setTimeout(() => socket.destroy(), 1000).unref());
}

function respondRefusal(res: http.ServerResponse, refusal: Refusal) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${refusal.reason}\n`;
  res.writeHead(refusal.status, reasonPhrase(refusal.reason), {
    ...refusal.headers,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

const withTimeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

function connectTo(address: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** Starts the proxy; resolves once it listens. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
  const maxPerToken = options.maxConnectionsPerToken ?? 64;
  const grants = new Map<string, GrantState>();
  const tunnels = new Set<Duplex>();

  let own = localAddresses();
  let ownCheckedAt = Date.now();
  const allowedAddress = (ip: string) => {
    if (Date.now() - ownCheckedAt > 60_000) {
      own = localAddresses();
      ownCheckedAt = Date.now();
    }
    if (options.unsafeAllowLoopback && (ip === "::1" || parseIPv4(ip)?.[0] === 127)) return true;
    return !isBlockedAddress(ip, own);
  };

  const resolve = options.lookup ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));

  const grantFor = (header: string | undefined, socket: Duplex): GrantState => {
    const token = tokenFrom(header);
    const grant = token ? grants.get(token) : undefined;
    const from = addressKey((socket as net.Socket).remoteAddress ?? "");
    if (!grant || from === null || from !== grant.client) throw AUTH_REQUIRED;
    return grant;
  };

  /** Checks the policy, resolves once and connects to a vetted address. Counts against the token. */
  async function openUpstream(grant: GrantState, host: string, port: number): Promise<net.Socket> {
    if (!matchesEgress(host, port, grant.egress)) {
      const reason =
        grant.egress !== "public" && grant.egress.length === 0
          ? "Blocked by the sandbox: network access is off for this command"
          : `Blocked by the sandbox network policy: ${host}:${port} is not an allowed destination`;
      throw new Refusal(403, reason);
    }
    if (grant.active >= maxPerToken) {
      throw new Refusal(429, `Blocked by the sandbox: more than ${maxPerToken} open connections from this command`);
    }
    grant.active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        grant.active--;
      }
    };
    try {
      const deadline = Date.now() + connectTimeoutMs;
      const name = normalizeHost(host);
      let addresses: string[];
      if (net.isIP(name)) {
        addresses = [name];
      } else {
        const found = await withTimeout(
          resolve(name),
          connectTimeoutMs,
          () => new Refusal(504, `Timed out resolving ${host}`),
        ).catch((error: unknown) => {
          if (error instanceof Refusal) throw error;
          throw new Refusal(502, `Could not resolve ${host}`);
        });
        // IPv4 first: Docker networks usually have no IPv6 route.
        addresses = found.sort((a, b) => a.family - b.family).map((entry) => entry.address);
      }
      const vetted = addresses.filter(allowedAddress);
      if (vetted.length === 0) {
        throw new Refusal(403, `Blocked by the sandbox: ${host} is a private or reserved address`);
      }
      let lastError: unknown;
      for (const address of vetted.slice(0, 3)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let socket: net.Socket;
        try {
          socket = await connectTo(address, port, remaining);
        } catch (error) {
          lastError = error;
          continue;
        }
        socket.on("close", release);
        if (grant.revoked) {
          // Revoked while resolving or connecting: the exec is over.
          socket.destroy();
          throw AUTH_REQUIRED;
        }
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 60_000);
        return socket;
      }
      const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ETIMEDOUT" || lastError === undefined) {
        throw new Refusal(504, `Timed out connecting to ${host}:${port}`);
      }
      throw new Refusal(502, `Could not connect to ${host}:${port}${code ? ` (${code})` : ""}`);
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Ties sockets to a grant so revoke() closes them; false (sockets destroyed) when already revoked. */
  const track = (grant: GrantState, ...sockets: Duplex[]): boolean => {
    if (grant.revoked) {
      for (const socket of sockets) socket.destroy();
      return false;
    }
    for (const socket of sockets) {
      grant.sockets.add(socket);
      socket.once("close", () => grant.sockets.delete(socket));
    }
    return true;
  };

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const grant = grantFor(req.headers["proxy-authorization"], req.socket);
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        throw new Refusal(400, "Bad request: this is a proxy, send absolute URLs or use CONNECT");
      }
      if (url.protocol !== "http:") {
        throw new Refusal(400, `Bad request: only http URLs can be forwarded, use CONNECT for ${url.protocol}`);
      }
      const port = url.port ? Number(url.port) : 80;
      const socket = await openUpstream(grant, url.hostname, port);
      if (!track(grant, socket)) throw AUTH_REQUIRED;
      // Host follows the URL the policy checked, so a different Host header cannot reach another site.
      const headers = { ...endToEndHeaders(req.headers), host: url.host, connection: "close" };
      const upstream = http.request({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        createConnection: () => socket,
      });
      socket.setTimeout(idleTimeoutMs, () => socket.destroy());
      upstream.on("response", (response) => {
        res.writeHead(response.statusCode ?? 502, response.statusMessage, endToEndHeaders(response.headers));
        response.pipe(res);
        response.on("error", () => res.destroy());
      });
      upstream.on("error", () => {
        if (!res.headersSent) respondRefusal(res, new Refusal(502, `Connection to ${url.host} failed`));
        else res.destroy();
      });
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    } catch (error) {
      respondRefusal(res, error instanceof Refusal ? error : new Refusal(502, "Proxy error"));
    }
  }

  async function handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    try {
      const grant = grantFor(req.headers["proxy-authorization"], client);
      const target = parseAuthority(req.url ?? "");
      if (!target) throw new Refusal(400, "Bad request: CONNECT needs host:port");
      const upstream = await openUpstream(grant, target.host, target.port);
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      if (!track(grant, upstream)) throw AUTH_REQUIRED;
      track(grant, client);
      tunnels.add(upstream);
      upstream.once("close", () => tunnels.delete(upstream));
      const closeBoth = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", closeBoth);
      client.on("error", closeBoth);
      upstream.on("close", closeBoth);
      client.on("close", closeBoth);
      upstream.setTimeout(idleTimeoutMs, closeBoth);
      if ("setTimeout" in client && typeof client.setTimeout === "function") {
        (client as net.Socket).setTimeout(idleTimeoutMs, closeBoth);
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (error) {
      if (!client.destroyed) writeRefusal(client, error instanceof Refusal ? error : new Refusal(502, "Proxy error"));
    }
  }

  const server = http.createServer();
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // uploads may take long; idle sockets are closed by their own timeouts
  server.maxConnections = 4096;
  server.on("request", (req, res) => void handleRequest(req, res));
  server.on("connect", (req, socket, head) => void handleConnect(req, socket, head));
  server.on("upgrade", (_req, socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    writeRefusal(socket, new Refusal(501, "Upgrade through the proxy is not supported, use CONNECT"));
  });
  server.on("clientError", (_error, socket: Duplex) => {
    if (!socket.destroyed) writeRefusal(socket, new Refusal(400, "Bad request"));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? EGRESS_PROXY_PORT, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {});
  const address = server.address() as net.AddressInfo;
  const urlHost = net.isIPv6(options.host) ? `[${options.host}]` : options.host;

  return {
    host: options.host,
    port: address.port,
    register(egress, client) {
      const key = addressKey(client);
      if (!key) throw new Error(`Invalid client address: ${client}`);
      const token = randomBytes(24).toString("base64url");
      const state: GrantState = { egress, client: key, active: 0, sockets: new Set(), revoked: false };
      grants.set(token, state);
      return {
        token,
        url: `http://${token}:x@${urlHost}:${address.port}`,
        revoke() {
          state.revoked = true;
          grants.delete(token);
          for (const socket of state.sockets) socket.destroy();
          state.sockets.clear();
        },
      };
    },
    async close() {
      grants.clear();
      for (const socket of tunnels) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

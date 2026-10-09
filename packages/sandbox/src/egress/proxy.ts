/**
 * Egress proxy for sandbox containers. Containers sit on an internal network with no route out; the
 * only way out is this proxy, which the worker runs on its address in that network. Plain HTTP goes
 * through as absolute-URI requests, everything else (HTTPS, git, ssh over 443) through CONNECT.
 *
 * Credential routes (routes.ts) are served here too: a request to the route host, as an absolute URI
 * or inside a CONNECT tunnel to it (Node's fetch tunnels plain http as well), goes to the route's
 * upstream over verified TLS with the route's headers, which never enter the sandbox.
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
import tls from "node:tls";
import type { CredentialRoute, Egress } from "../types";
import { addressKey, isBlockedAddress, localAddresses, parseIPv4 } from "./addresses";
import { matchesEgress, normalizeHost, parseAuthority } from "./policy";
import {
  parseRouteTarget,
  type ResolvedRoute,
  resolveRoute,
  ROUTE_HOST,
  routeLocation,
  upstreamHeaders,
  upstreamUrl,
} from "./routes";

export const EGRESS_PROXY_PORT = 3128;

export type EgressProxyOptions = {
  /** Address to listen on: the worker's address in the sandbox network. */
  host: string;
  /** Default 3128; 0 picks a free port. */
  port?: number;
  /** Resolving and connecting upstream, default DEFAULT_CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
  /** A connection with no traffic either way is closed after this long, default DEFAULT_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Concurrent upstream connections per token, default DEFAULT_MAX_CONNECTIONS_PER_TOKEN. */
  maxConnectionsPerToken?: number;
  /** Tests only: allow loopback upstreams so local test servers are reachable. */
  unsafeAllowLoopback?: boolean;
  /** Tests only: the CA that route upstreams are verified against instead of the system's (a local test server). */
  upstreamCa?: string;
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
  /**
   * Registers a token for one exec, usable only from `client` (the container's address), with the
   * credential routes the exec may use. Throws on a malformed route.
   */
  register(egress: Egress, client: string, routes?: readonly CredentialRoute[]): EgressGrant;
  close(): Promise<void>;
};

type GrantState = {
  egress: Egress;
  client: string;
  routes: Map<string, ResolvedRoute>;
  active: number;
  sockets: Set<Duplex>;
  revoked: boolean;
};

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

const ROUTE_ADDRESS = new Refusal(
  400,
  `Bad request: credential routes are plain http URLs, http://${ROUTE_HOST}/<id>/..., as given in the environment`,
);

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

/**
 * Per-token caps. They stop a runaway workspace from exhausting the worker's sockets, not real work: a
 * crawler or a parallel download opens many connections at once, a slow server takes a while to accept,
 * and a long poll or a quiet build log stream keeps a connection open without traffic for many minutes.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_MAX_CONNECTIONS_PER_TOKEN = 256;

/** Starts the proxy; resolves once it listens. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxPerToken = options.maxConnectionsPerToken ?? DEFAULT_MAX_CONNECTIONS_PER_TOKEN;
  const grants = new Map<string, GrantState>();
  const tunnels = new Set<Duplex>();
  /** Tunnels to the route host, with the grant of the CONNECT request that opened each one. */
  const tunnelGrants = new WeakMap<Duplex, GrantState>();

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

  /** Checks the policy, then connects (`connectVetted`). */
  function openUpstream(grant: GrantState, host: string, port: number): Promise<net.Socket> {
    if (!matchesEgress(host, port, grant.egress)) {
      const reason =
        grant.egress !== "public" && grant.egress.length === 0
          ? "Blocked by the sandbox: network access is off for this command"
          : `Blocked by the sandbox network policy: ${host}:${port} is not an allowed destination`;
      throw new Refusal(403, reason);
    }
    return connectVetted(grant, host, port);
  }

  /** Resolves once and connects to a vetted address. Counts against the token. */
  async function connectVetted(grant: GrantState, host: string, port: number): Promise<net.Socket> {
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

  /**
   * Sends `req` upstream over `socket` and streams the answer back; `adjust` may change the headers
   * the client gets.
   */
  function relay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    socket: net.Socket,
    request: Pick<http.RequestOptions, "path" | "headers">,
    target: string,
    adjust: (headers: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders = (headers) => headers,
  ) {
    const upstream = http.request({ ...request, method: req.method, createConnection: () => socket });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    upstream.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, adjust(endToEndHeaders(response.headers)));
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      if (!res.headersSent) respondRefusal(res, new Refusal(502, `Connection to ${target} failed`));
      else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  /** A verified TLS connection to a route's upstream, over a vetted address. */
  async function openRouteUpstream(grant: GrantState, upstream: URL): Promise<tls.TLSSocket> {
    const host = normalizeHost(upstream.hostname);
    const socket = await connectVetted(grant, host, upstream.port ? Number(upstream.port) : 443);
    return new Promise((resolve, reject) => {
      const secure = tls.connect({
        socket,
        host,
        servername: net.isIP(host) ? undefined : host,
        ca: options.upstreamCa,
        ALPNProtocols: ["http/1.1"],
      });
      const fail = (error?: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        secure.destroy();
        const code = error?.code ?? "ETIMEDOUT";
        reject(new Refusal(502, `TLS connection to ${upstream.host} failed (${code})`));
      };
      const timer = setTimeout(fail, connectTimeoutMs);
      secure.once("error", fail);
      secure.once("secureConnect", () => {
        clearTimeout(timer);
        secure.off("error", fail);
        resolve(secure);
      });
    });
  }

  /** A request to the route host: on to the route's upstream, with the route's headers. */
  async function forwardRoute(
    grant: GrantState,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: URL,
  ): Promise<void> {
    if (target.port && target.port !== "80") throw ROUTE_ADDRESS;
    const parsed = parseRouteTarget(target.pathname + target.search);
    if (!parsed) throw ROUTE_ADDRESS;
    const route = grant.routes.get(parsed.id);
    if (!route) throw new Refusal(404, `Unknown credential route ${parsed.id}: it is not given to this command`);
    const url = upstreamUrl(route, parsed.rest);
    if (!url) throw new Refusal(403, `Blocked by the sandbox: the path is outside credential route ${route.id}`);
    const socket = await openRouteUpstream(grant, route.upstream);
    if (!track(grant, socket)) throw AUTH_REQUIRED;
    const headers = { ...upstreamHeaders(route, endToEndHeaders(req.headers)), connection: "close" };
    relay(req, res, socket, { path: url.pathname + url.search, headers }, url.host, (out) =>
      typeof out.location === "string" ? { ...out, location: routeLocation(route, out.location, url) } : out,
    );
  }

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
      if (normalizeHost(url.hostname) === ROUTE_HOST) return await forwardRoute(grant, req, res, url);
      const port = url.port ? Number(url.port) : 80;
      const socket = await openUpstream(grant, url.hostname, port);
      if (!track(grant, socket)) throw AUTH_REQUIRED;
      // Host follows the URL the policy checked, so a different Host header cannot reach another site.
      const headers = { ...endToEndHeaders(req.headers), host: url.host, connection: "close" };
      relay(req, res, socket, { path: `${url.pathname}${url.search}`, headers }, url.host);
    } catch (error) {
      respondRefusal(res, error instanceof Refusal ? error : new Refusal(502, "Proxy error"));
    }
  }

  /**
   * A request inside a CONNECT tunnel to the route host. It carries no proxy credentials: the tunnel
   * was granted to the CONNECT request's token, and revoking it closes the tunnel.
   */
  async function handleTunneledRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const grant = tunnelGrants.get(req.socket);
      if (!grant || grant.revoked) throw AUTH_REQUIRED;
      // Origin-form only; the Host header is not read, so the tunnel leads to the route host and nowhere else.
      const base = `http://${ROUTE_HOST}`;
      if (!URL.canParse(req.url ?? "", base)) throw ROUTE_ADDRESS;
      const url = new URL(req.url ?? "", base);
      if (url.host !== ROUTE_HOST) throw ROUTE_ADDRESS;
      await forwardRoute(grant, req, res, url);
    } catch (error) {
      respondRefusal(res, error instanceof Refusal ? error : new Refusal(502, "Proxy error"));
    }
  }

  /** Hands a CONNECT tunnel to the route host to the route server, which parses what comes through it. */
  function tunnelToRoutes(grant: GrantState, client: Duplex, head: Buffer) {
    if (!track(grant, client)) return;
    tunnelGrants.set(client, grant);
    if ("setTimeout" in client && typeof client.setTimeout === "function") {
      (client as net.Socket).setTimeout(idleTimeoutMs, () => client.destroy());
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) client.unshift(head);
    routeServer.emit("connection", client);
  }

  async function handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    try {
      const grant = grantFor(req.headers["proxy-authorization"], client);
      const target = parseAuthority(req.url ?? "");
      if (!target) throw new Refusal(400, "Bad request: CONNECT needs host:port");
      if (target.host === ROUTE_HOST) {
        if (target.port !== 80) throw ROUTE_ADDRESS;
        return tunnelToRoutes(grant, client, head);
      }
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
  // Never listens: it parses the requests inside CONNECT tunnels to the route host.
  const routeServer = http.createServer((req, res) => void handleTunneledRoute(req, res));
  routeServer.headersTimeout = 20_000;
  routeServer.requestTimeout = 0;
  for (const target of [server, routeServer]) {
    target.on("upgrade", (_req, socket: Duplex) => {
      socket.on("error", () => socket.destroy());
      writeRefusal(socket, new Refusal(501, "Upgrade through the proxy is not supported, use CONNECT"));
    });
    target.on("clientError", (_error, socket: Duplex) => {
      if (!socket.destroyed) writeRefusal(socket, new Refusal(400, "Bad request"));
    });
  }

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
    register(egress, client, routes = []) {
      const key = addressKey(client);
      if (!key) throw new Error(`Invalid client address: ${client}`);
      const resolved = new Map<string, ResolvedRoute>();
      for (const route of routes) {
        if (resolved.has(route.id)) throw new Error(`Duplicate credential route id: ${route.id}`);
        resolved.set(route.id, resolveRoute(route));
      }
      const token = randomBytes(24).toString("base64url");
      const state: GrantState = {
        egress,
        client: key,
        routes: resolved,
        active: 0,
        sockets: new Set(),
        revoked: false,
      };
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

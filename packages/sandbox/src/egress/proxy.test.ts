import http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressProxy } from "./proxy";

type Seen = { url?: string; headers: http.IncomingHttpHeaders };

let upstream: http.Server;
let upstreamPort: number;
let lastSeen: Seen = { headers: {} };
let proxy: EgressProxy;
let strictProxy: EgressProxy;
const LOCAL = "127.0.0.1";

const listen = (server: http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)),
  );

const auth = (token: string) => `Basic ${Buffer.from(`${token}:`).toString("base64")}`;

function viaProxy(target: EgressProxy, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; message: string; body: string }>((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? "", body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connect(target: EgressProxy, authority: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; message: string; socket: Duplex }>((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, method: "CONNECT", path: authority, headers });
    req.on("connect", (res, socket) => {
      socket.on("error", () => {}); // the proxy resets tunnels it closes
      resolve({ status: res.statusCode ?? 0, message: res.statusMessage ?? "", socket });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Sends a plain HTTP request over an established tunnel and returns the raw response. */
function requestOverTunnel(socket: Duplex, path: string) {
  return new Promise<string>((resolve) => {
    let raw = "";
    socket.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    socket.on("end", () => resolve(raw));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastSeen = { url: req.url, headers: req.headers };
    if (req.url === "/hold") return; // never answers, keeps the connection open
    res.writeHead(200, { "content-type": "text/plain", connection: "close", "proxy-authenticate": "leak" });
    res.end("hello");
  });
  upstreamPort = await listen(upstream);
  proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, unsafeAllowLoopback: true, maxConnectionsPerToken: 2 });
  strictProxy = await startEgressProxy({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await proxy.close();
  await strictProxy.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

describe("egress proxy", () => {
  it("forwards allowed HTTP requests without proxy credentials or hop-by-hop headers", async () => {
    const grant = proxy.register([`localhost:${upstreamPort}`], LOCAL);
    const res = await viaProxy(proxy, `http://localhost:${upstreamPort}/path?q=1`, {
      "proxy-authorization": auth(grant.token),
      "proxy-connection": "keep-alive",
      connection: "keep-alive, x-secret",
      "x-secret": "1",
      "x-kept": "yes",
      host: "other.example",
    });
    expect(res).toMatchObject({ status: 200, body: "hello" });
    expect(lastSeen.url).toBe("/path?q=1");
    expect(lastSeen.headers.host).toBe(`localhost:${upstreamPort}`);
    expect(lastSeen.headers["x-kept"]).toBe("yes");
    for (const name of ["proxy-authorization", "proxy-connection", "x-secret"]) {
      expect(lastSeen.headers[name]).toBeUndefined();
    }
    grant.revoke();
  });

  it("builds a proxy URL with the token as the username", () => {
    const grant = proxy.register([], LOCAL);
    expect(grant.url).toBe(`http://${grant.token}:x@127.0.0.1:${proxy.port}`);
    grant.revoke();
  });

  it("asks for credentials without a valid token", async () => {
    const res = await viaProxy(proxy, `http://localhost:${upstreamPort}/`);
    expect(res.status).toBe(407);
    const grant = proxy.register("public", LOCAL);
    grant.revoke();
    const revoked = await viaProxy(proxy, `http://localhost:${upstreamPort}/`, {
      "proxy-authorization": auth(grant.token),
    });
    expect(revoked.status).toBe(407);
    const tunnel = await connect(proxy, `localhost:${upstreamPort}`, { "proxy-authorization": auth("nope") });
    expect(tunnel.status).toBe(407);
    tunnel.socket.destroy();
  });

  it("refuses hosts outside the list with a readable reason", async () => {
    const grant = proxy.register(["pypi.org"], LOCAL);
    const res = await viaProxy(proxy, `http://localhost:${upstreamPort}/`, { "proxy-authorization": auth(grant.token) });
    expect(res.status).toBe(403);
    expect(res.body).toContain(`localhost:${upstreamPort} is not an allowed destination`);
    expect(res.message).toContain("not an allowed destination");
    const off = proxy.register([], LOCAL);
    const offRes = await connect(proxy, "pypi.org:443", { "proxy-authorization": auth(off.token) });
    expect(offRes.status).toBe(403);
    expect(offRes.message).toContain("network access is off");
    offRes.socket.destroy();
    grant.revoke();
    off.revoke();
  });

  it("tunnels CONNECT to allowed hosts", async () => {
    const grant = proxy.register([`localhost:${upstreamPort}`], LOCAL);
    const tunnel = await connect(proxy, `localhost:${upstreamPort}`, { "proxy-authorization": auth(grant.token) });
    expect(tunnel.status).toBe(200);
    const raw = await requestOverTunnel(tunnel.socket, "/tunnel");
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw).toContain("hello");
    expect(lastSeen.url).toBe("/tunnel");
    grant.revoke();
  });

  it("refuses private and loopback addresses even when public is allowed", async () => {
    const grant = strictProxy.register("public", LOCAL);
    const headers = { "proxy-authorization": auth(grant.token) };
    for (const target of [`127.0.0.1:${upstreamPort}`, `localhost:${upstreamPort}`, "10.0.0.1:443", "[::1]:443"]) {
      const res = await connect(strictProxy, target, headers);
      expect(res.status, target).toBe(403);
      expect(res.message).toContain("private or reserved");
      res.socket.destroy();
    }
    const forwarded = await viaProxy(strictProxy, "http://169.254.169.254/latest/meta-data/", headers);
    expect(forwarded.status).toBe(403);
    grant.revoke();
  });

  it("caps concurrent connections per token and closes them on revoke", async () => {
    const grant = proxy.register([`localhost:${upstreamPort}`], LOCAL);
    const headers = { "proxy-authorization": auth(grant.token) };
    const first = await connect(proxy, `localhost:${upstreamPort}`, headers);
    const second = await connect(proxy, `localhost:${upstreamPort}`, headers);
    const third = await connect(proxy, `localhost:${upstreamPort}`, headers);
    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    third.socket.destroy();
    const closed = new Promise((resolve) => first.socket.once("close", resolve));
    first.socket.write("GET /hold HTTP/1.1\r\nHost: localhost\r\n\r\n");
    grant.revoke();
    await closed;
    second.socket.destroy();
  });

  it("accepts a token only from the address it was issued to", async () => {
    const elsewhere = proxy.register("public", "10.0.0.7");
    const res = await viaProxy(proxy, `http://localhost:${upstreamPort}/`, {
      "proxy-authorization": auth(elsewhere.token),
    });
    expect(res.status).toBe(407);
    const tunnel = await connect(proxy, `localhost:${upstreamPort}`, { "proxy-authorization": auth(elsewhere.token) });
    expect(tunnel.status).toBe(407);
    tunnel.socket.destroy();
    elsewhere.revoke();
    // An IPv4-mapped registration matches the plain IPv4 peer.
    const mapped = proxy.register([`localhost:${upstreamPort}`], "::ffff:127.0.0.1");
    const ok = await viaProxy(proxy, `http://localhost:${upstreamPort}/`, { "proxy-authorization": auth(mapped.token) });
    expect(ok.status).toBe(200);
    mapped.revoke();
    expect(() => proxy.register("public", "not-an-ip")).toThrow();
  });

  it("drops a connection whose token was revoked while it was being opened", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resolving = () => {};
    const started = new Promise<void>((resolve) => (resolving = resolve));
    const slow = await startEgressProxy({
      host: LOCAL,
      port: 0,
      unsafeAllowLoopback: true,
      lookup: async () => {
        resolving();
        await gate;
        return [{ address: LOCAL, family: 4 }];
      },
    });
    try {
      const grant = slow.register(["slow.test:" + upstreamPort], LOCAL);
      const pending = connect(slow, `slow.test:${upstreamPort}`, { "proxy-authorization": auth(grant.token) });
      await started;
      grant.revoke();
      release();
      const res = await pending;
      expect(res.status).toBe(407);
      res.socket.destroy();
    } finally {
      await slow.close();
    }
  });

  it("reports upstreams that refuse the connection", async () => {
    const grant = proxy.register("public", LOCAL);
    // Port 1 (tcpmux) has nothing listening on a normal machine.
    const res = await connect(proxy, "127.0.0.1:1", {
      "proxy-authorization": auth(grant.token),
    });
    expect(res.status).toBe(502);
    expect(res.message).toContain("Could not connect");
    res.socket.destroy();
    grant.revoke();
  });

  it("rejects requests that are not proxy requests", async () => {
    const grant = proxy.register("public", LOCAL);
    const res = await viaProxy(proxy, "/relative", { "proxy-authorization": auth(grant.token) });
    expect(res.status).toBe(400);
    grant.revoke();
  });
});

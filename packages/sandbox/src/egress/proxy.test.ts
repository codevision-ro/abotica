import { execFile, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testCertificate } from "../testing";
import { startEgressProxy, type EgressProxy } from "./proxy";
import { ROUTE_HOST, routeUrl } from "./routes";

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

/** A proxied request whose response headers are returned as they are (redirects are not followed). */
function rawViaProxy(target: EgressProxy, path: string, headers: Record<string, string> = {}) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, path, headers }, (res) => {
      res.resume();
      resolve(res);
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

describe("credential routes", () => {
  const SECRET = "Bearer sk-route-secret-0123456789";
  const certificate = testCertificate();
  let api: https.Server;
  let apiPort: number;
  let routed: EgressProxy;
  let untrusting: EgressProxy;

  /** Answers with what it received; a few paths redirect. */
  const echo = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/v1/moved") {
      res.writeHead(302, { location: `https://localhost:${apiPort}/v1/echo?from=moved` });
      return res.end();
    }
    if (req.url === "/v1/away") {
      res.writeHead(302, { location: "https://elsewhere.example/v1/echo" });
      return res.end();
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  };

  const route = () => ({ id: "api", upstream: `https://localhost:${apiPort}/v1`, headers: { Authorization: SECRET } });
  const registerRoute = (target = routed) => target.register([], LOCAL, [route()]);
  type Echo = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
  const parsed = (body: string) => JSON.parse(body) as Echo;

  beforeAll(async () => {
    api = https.createServer({ cert: certificate.cert, key: certificate.key }, echo);
    apiPort = await new Promise<number>((resolve) =>
      api.listen(0, "127.0.0.1", () => resolve((api.address() as net.AddressInfo).port)),
    );
    routed = await startEgressProxy({ host: LOCAL, port: 0, unsafeAllowLoopback: true, upstreamCa: certificate.cert });
    untrusting = await startEgressProxy({ host: LOCAL, port: 0, unsafeAllowLoopback: true });
  });

  afterAll(async () => {
    await routed.close();
    await untrusting.close();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });

  it("forwards to the upstream with the route's header instead of the client's, whatever Host says", async () => {
    const grant = registerRoute();
    const res = await viaProxy(routed, `${routeUrl("api")}/echo?q=1`, {
      "proxy-authorization": auth(grant.token),
      authorization: "Bearer abotica-proxy-managed",
      host: "evil.example",
      "x-kept": "yes",
    });
    expect(res.status).toBe(200);
    const seen = parsed(res.body);
    expect(seen.url).toBe("/v1/echo?q=1");
    expect(seen.headers.authorization).toBe(SECRET);
    expect(seen.headers.host).toBe(`localhost:${apiPort}`);
    expect(seen.headers["x-kept"]).toBe("yes");
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
    grant.revoke();
  });

  it("needs no egress entry for its upstream, and the egress list gives no route", async () => {
    const grant = routed.register("public", LOCAL);
    const res = await viaProxy(routed, `${routeUrl("api")}/echo`, { "proxy-authorization": auth(grant.token) });
    expect(res.status).toBe(404);
    expect(res.message).toContain("Unknown credential route api");
    grant.revoke();
  });

  it("serves requests inside a CONNECT tunnel to the route host", async () => {
    const grant = registerRoute();
    const tunnel = await connect(routed, `${ROUTE_HOST}:80`, { "proxy-authorization": auth(grant.token) });
    expect(tunnel.status).toBe(200);
    const raw = await requestOverTunnel(tunnel.socket, "/api/echo?via=tunnel");
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw).toContain('"url":"/v1/echo?via=tunnel"');
    expect(raw).toContain(SECRET);
    grant.revoke();
  });

  it("leads a tunnel to the route host nowhere else, whatever the request inside names", async () => {
    const grant = routed.register("public", LOCAL, [route()]);
    const tunnel = await connect(routed, `${ROUTE_HOST}:80`, { "proxy-authorization": auth(grant.token) });
    const raw = await requestOverTunnel(tunnel.socket, `http://localhost:${upstreamPort}/tunnel-escape`);
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect(lastSeen.url).not.toBe("/tunnel-escape");
    grant.revoke();
  });

  it("works only for the token's own container and exec", async () => {
    const elsewhere = routed.register([], "10.0.0.7", [route()]);
    const res = await viaProxy(routed, `${routeUrl("api")}/echo`, { "proxy-authorization": auth(elsewhere.token) });
    expect(res.status).toBe(407);
    const tunnel = await connect(routed, `${ROUTE_HOST}:80`, { "proxy-authorization": auth(elsewhere.token) });
    expect(tunnel.status).toBe(407);
    tunnel.socket.destroy();
    elsewhere.revoke();

    const ended = registerRoute();
    ended.revoke();
    const after = await viaProxy(routed, `${routeUrl("api")}/echo`, { "proxy-authorization": auth(ended.token) });
    expect(after.status).toBe(407);
  });

  it("closes a tunnel to the route host when the exec ends", async () => {
    const grant = registerRoute();
    const tunnel = await connect(routed, `${ROUTE_HOST}:80`, { "proxy-authorization": auth(grant.token) });
    const closed = new Promise((resolve) => tunnel.socket.once("close", resolve));
    grant.revoke();
    await closed;
  });

  it("refuses other addresses of the route host and paths that are no route", async () => {
    const grant = registerRoute();
    const headers = { "proxy-authorization": auth(grant.token) };
    const tls = await connect(routed, `${ROUTE_HOST}:443`, headers);
    expect(tls.status).toBe(400);
    expect(tls.message).toContain(`http://${ROUTE_HOST}/<id>`);
    tls.socket.destroy();
    for (const url of [`http://${ROUTE_HOST}:8080/api/echo`, `http://${ROUTE_HOST}/`]) {
      expect((await viaProxy(routed, url, headers)).status, url).toBe(400);
    }
    const escaped = await viaProxy(routed, `${routeUrl("api")}/%2e%2e/admin`, headers);
    expect(escaped.status).toBe(404);
    grant.revoke();
  });

  it("sends redirects below the base back through the route and leaves the others alone", async () => {
    const grant = registerRoute();
    const headers = { "proxy-authorization": auth(grant.token) };
    const inside = await rawViaProxy(routed, `${routeUrl("api")}/moved`, headers);
    expect(inside.headers.location).toBe(`${routeUrl("api")}/echo?from=moved`);
    const outside = await rawViaProxy(routed, `${routeUrl("api")}/away`, headers);
    expect(outside.headers.location).toBe("https://elsewhere.example/v1/echo");
    grant.revoke();
  });

  it("verifies the upstream's certificate and never sends the header to one it cannot verify", async () => {
    const grant = registerRoute(untrusting);
    const res = await viaProxy(untrusting, `${routeUrl("api")}/echo`, { "proxy-authorization": auth(grant.token) });
    expect(res.status).toBe(502);
    expect(res.message).toMatch(/^TLS connection to localhost:\d+ failed \([A-Z_]+\)$/);
    expect(res.body).not.toContain(SECRET);
    grant.revoke();
  });

  it("applies the address checks to the upstream", async () => {
    const grant = strictProxy.register([], LOCAL, [route()]);
    const res = await viaProxy(strictProxy, `${routeUrl("api")}/echo`, { "proxy-authorization": auth(grant.token) });
    expect(res.status).toBe(403);
    expect(res.message).toContain("private or reserved");
    grant.revoke();
  });

  it("rejects malformed routes when the exec is registered", () => {
    expect(() => routed.register([], LOCAL, [{ ...route(), upstream: "http://localhost/v1" }])).toThrow("https");
    expect(() => routed.register([], LOCAL, [route(), route()])).toThrow("Duplicate");
  });

  describe("with real clients", () => {
    const run = promisify(execFile);

    /** Runs a client with the proxy environment of a sandboxed exec and returns what the upstream saw. */
    async function through(file: string, args: string[]): Promise<Echo> {
      const grant = registerRoute();
      const proxyUrl = grant.url;
      try {
        const { stdout } = await run(file, args, {
          env: {
            PATH: process.env.PATH,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            NO_PROXY: "",
            no_proxy: "",
            NODE_USE_ENV_PROXY: "1",
          },
        });
        return parsed(stdout);
      } finally {
        grant.revoke();
      }
    }

    /** Whether a client is installed; the ones that are not are skipped. */
    const has = (command: string, args: string[]) => spawnSync(command, args, { stdio: "ignore" }).status === 0;

    it("Node fetch (NODE_USE_ENV_PROXY tunnels plain http too)", async () => {
      const script = `fetch(${JSON.stringify(`${routeUrl("api")}/echo`)}, { method: "POST", body: "hi", headers: { authorization: "Bearer dummy" } }).then((r) => r.text()).then((t) => process.stdout.write(t))`;
      const seen = await through(process.execPath, ["-e", script]);
      expect(seen).toMatchObject({ method: "POST", url: "/v1/echo", body: "hi" });
      expect(seen.headers.authorization).toBe(SECRET);
    });

    it.runIf(has("curl", ["--version"]))("curl", async () => {
      const seen = await through("curl", ["-sS", "-H", "Authorization: Bearer dummy", `${routeUrl("api")}/echo`]);
      expect(seen).toMatchObject({ method: "GET", url: "/v1/echo" });
      expect(seen.headers.authorization).toBe(SECRET);
    });

    it.runIf(has("python3", ["-c", "import requests"]))("Python requests", async () => {
      const script = `import requests, sys; sys.stdout.write(requests.get(${JSON.stringify(`${routeUrl("api")}/echo`)}, headers={"Authorization": "Bearer dummy"}).text)`;
      const seen = await through("python3", ["-c", script]);
      expect(seen).toMatchObject({ method: "GET", url: "/v1/echo" });
      expect(seen.headers.authorization).toBe(SECRET);
    });
  });
});

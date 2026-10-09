/**
 * The worker's preview server: answers every `<code>.<preview host>` request routed to it. Worker
 * only, since live previews reach containers on the sandbox network that only the worker joins.
 *
 * - Static previews are files from their copy on disk, never anything outside it.
 * - Live previews are proxied, websockets included, to the port the preview names, of the container
 *   of the preview's workspace: both come from the database, never from the request.
 * - Private previews need the cookie this server sets after redeeming a ticket from the app.
 * - `/__abotica/tls?domain=` answers the reverse proxy's question before it issues a certificate:
 *   only for hosts of previews that exist.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "@abotica/db";
import { sql } from "@abotica/db/orm";
import { env } from "../infra/env";
import { mimeTypeFor } from "../files/file-types";
import { redis } from "../infra/redis";
import { safeSnapshotPath } from "./preview-snapshot";
import { safeReturnPath } from "../platform/return-path";
import {
  type Preview,
  previewByHost,
  previewCookie,
  previewCookieName,
  previewDir,
  previewHostOf,
  previewsSecure,
  redeemPreviewTicket,
  validPreviewCookie,
} from "./previews";
import { touchWorkspace } from "./sandbox";
import { currentSandboxBackend } from "./sandbox-runtime";
import { settingsTranslator } from "../settings/settings";

const AUTH_PATH = "/__abotica/auth";
const TLS_PATH = "/__abotica/tls";
/** The worker's health check (the container healthcheck): reached on localhost, never on a preview host. */
const HEALTH_PATH = "/__abotica/health";
/** A preview found by host is reused this long, so a page's assets do not each query the database. */
const LOOKUP_TTL_MS = 5_000;
/** The workspace's last use is recorded at most this often per workspace. */
const TOUCH_EVERY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** A refused connection to a live preview's app is retried this often, up to about 2 s in all. */
const CONNECT_RETRY_MS = 100;
const CONNECT_ATTEMPTS = 20;

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
]);

/** On every response of a preview: kept out of search engines, no referrer to the outside. */
const BASE_HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

const lookups = new Map<string, { preview: Preview | null; at: number }>();
const touched = new Map<string, number>();

async function lookup(host: string): Promise<Preview | null> {
  const cached = lookups.get(host);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.preview;
  const preview = await previewByHost(host);
  lookups.set(host, { preview, at: Date.now() });
  if (lookups.size > 1000) lookups.delete(lookups.keys().next().value!);
  return preview;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** An HTML page of the server itself: `title` and `body` escaped already, no script, nothing loaded. */
function sendHtml(
  res: http.ServerResponse,
  page: { status: number; cacheControl: string; title: string; style: string; body: string },
) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title}</title><style>${page.style}</style></head><body><h1>${page.title}</h1>${page.body}</body></html>`;
  res.writeHead(page.status, {
    ...BASE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": page.cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(html);
}

/** A small page of the server itself (not found, not running), in the app's language. */
async function sendPage(res: http.ServerResponse, status: number, key: "notFound" | "notRunning" | "denied") {
  const t = await settingsTranslator();
  sendHtml(res, {
    status,
    cacheControl: "no-store",
    title: escapeHtml(t(`previews.page.${key}.title`)),
    style:
      "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#334155}h1{font-size:1.25rem;color:#0f172a}",
    body: `<p>${escapeHtml(t(`previews.page.${key}.body`))}</p>`,
  });
}

function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** The request's cookies without the preview's own, which the app behind a live preview never sees. */
function cookiesWithout(header: string | undefined, name: string): string | undefined {
  const kept = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=")[0] !== name);
  return kept.length ? kept.join("; ") : undefined;
}

function hasAccess(req: http.IncomingMessage, preview: Preview): boolean {
  return preview.public || validPreviewCookie(cookieOf(req.headers.cookie, previewCookieName()), preview.id);
}

/** Sends a visitor without access through the app, which checks the session and comes back with a ticket. */
function redirectToApp(res: http.ServerResponse, preview: Preview, returnPath: string) {
  const target = new URL(`/preview/${preview.id}`, env().APP_URL);
  target.searchParams.set("return", returnPath);
  res.writeHead(302, { ...BASE_HEADERS, location: target.toString(), "cache-control": "no-store" });
  res.end();
}

async function redeem(req: http.IncomingMessage, res: http.ServerResponse, preview: Preview, url: URL) {
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!(await redeemPreviewTicket(ticket, preview.id))) return sendPage(res, 403, "denied");
  const cookie = previewCookie(preview);
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${cookie.maxAgeSeconds}`];
  if (previewsSecure()) attributes.push("Secure");
  res.writeHead(302, {
    ...BASE_HEADERS,
    "set-cookie": `${previewCookieName()}=${cookie.value}; ${attributes.join("; ")}`,
    location: safeReturnPath(url.searchParams.get("return")),
    "cache-control": "no-store",
  });
  res.end();
}

/** Lists a folder of a static copy that has no index.html. */
function listing(res: http.ServerResponse, title: string, urlPath: string, names: string[]) {
  const base = urlPath.endsWith("/") ? urlPath : `${urlPath}/`;
  const items = names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `<li><a href="${escapeHtml(base + encodeURIComponent(name))}">${escapeHtml(name)}</a></li>`)
    .join("");
  sendHtml(res, {
    status: 200,
    cacheControl: "no-cache",
    title: escapeHtml(title),
    style: "body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}",
    body: `<ul>${items}</ul>`,
  });
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, preview: Preview, url: URL) {
  const root = previewDir(preview.id);
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return sendPage(res, 404, "notFound");
  }
  const relative = decoded === "/" ? preview.entry || "" : safeSnapshotPath(decoded.slice(1));
  if (relative === null) return sendPage(res, 404, "notFound");
  let file = relative ? path.join(root, ...relative.split("/")) : root;
  if (file !== root && !file.startsWith(root + path.sep)) return sendPage(res, 404, "notFound");
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    const index = path.join(file, "index.html");
    const indexInfo = await stat(index).catch(() => null);
    if (indexInfo?.isFile()) {
      file = index;
      info = indexInfo;
    } else {
      return listing(res, preview.title, url.pathname, await readdir(file));
    }
  }
  if (!info?.isFile()) return sendPage(res, 404, "notFound");
  const type = mimeTypeFor(file);
  const textual = type.startsWith("text/") || type === "application/javascript" || type === "image/svg+xml";
  res.writeHead(200, {
    ...BASE_HEADERS,
    "content-type": textual ? `${type}; charset=utf-8` : type,
    "content-length": info.size,
    "cache-control": "no-cache",
    "last-modified": info.mtime.toUTCString(),
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

/** Connects to a port of a container, giving up after CONNECT_TIMEOUT_MS. */
function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, noDelay: true });
    const onTimeout = () => socket.destroy(new Error("timeout"));
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("timeout", onTimeout);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("timeout", onTimeout).off("error", reject);
      resolve(socket);
    });
  });
}

/**
 * A connection to the app of a live preview, waking its workspace and marking it as used; null when
 * the workspace is not running or nothing answers. A refused connection is retried for a moment: an
 * app in a workspace that was just unpaused may not accept connections yet.
 */
async function connectLive(preview: Preview): Promise<net.Socket | null> {
  const address = await currentSandboxBackend()?.wake(preview.workspaceKey);
  if (!address) return null;
  const last = touched.get(preview.workspaceKey) ?? 0;
  if (Date.now() - last > TOUCH_EVERY_MS) {
    touched.set(preview.workspaceKey, Date.now());
    void touchWorkspace(preview.workspaceKey).catch(() => {});
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect(address, preview.port!);
    } catch (error) {
      if (attempt >= CONNECT_ATTEMPTS || (error as NodeJS.ErrnoException).code !== "ECONNREFUSED") return null;
      await sleep(CONNECT_RETRY_MS);
    }
  }
}

/** Headers for the app behind a live preview: the visitor's, without hop-by-hop ones and our cookie. */
function upstreamHeaders(req: http.IncomingMessage, keepUpgrade: boolean): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === "cookie") continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
    out[name] = value;
  }
  const cookie = cookiesWithout(req.headers.cookie, previewCookieName());
  if (cookie) out.cookie = cookie;
  const forwardedFor = req.headers["x-forwarded-for"];
  const client = req.socket.remoteAddress ?? "";
  out["x-forwarded-for"] = forwardedFor ? `${forwardedFor}, ${client}` : client;
  out["x-forwarded-host"] = req.headers.host ?? "";
  out["x-forwarded-proto"] = previewsSecure() ? "https" : "http";
  return out;
}

async function proxyLive(req: http.IncomingMessage, res: http.ServerResponse, preview: Preview) {
  const connection = await connectLive(preview);
  if (!connection) return sendPage(res, 502, "notRunning");
  const upstream = http.request({
    createConnection: () => connection,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, false),
    timeout: CONNECT_TIMEOUT_MS,
  });
  upstream.on("response", (response) => {
    const headers: http.OutgoingHttpHeaders = { ...BASE_HEADERS };
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
    }
    upstream.setTimeout(0);
    res.writeHead(response.statusCode ?? 502, response.statusMessage, headers);
    response.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) void sendPage(res, 502, "notRunning");
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

/** Websockets (a dev server's live reload) of a live preview, piped both ways once the app accepts. */
async function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  socket.on("error", () => socket.destroy());
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  const host = previewHostOf(req.headers.host);
  const preview = host ? await lookup(host) : null;
  if (!preview || preview.kind !== "live") return refuse("404 Not Found");
  if (!hasAccess(req, preview)) return refuse("401 Unauthorized");
  const connection = await connectLive(preview);
  if (!connection) return refuse("502 Bad Gateway");
  const upstream = http.request({
    createConnection: () => connection,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, true),
    timeout: CONNECT_TIMEOUT_MS,
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0);
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => socket.destroy());
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("response", (response) => {
    // The app answered without switching protocols: pass its answer on and close.
    socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
    response.resume();
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => refuse("502 Bad Gateway"));
  upstream.end();
}

/** Whether the worker reaches what every job needs: the database and Redis. */
async function workerHealthy(): Promise<boolean> {
  try {
    await Promise.all([db.execute(sql`select 1`), redis().ping()]);
    return true;
  } catch {
    return false;
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://preview.invalid");
  const host = previewHostOf(req.headers.host);
  if (!host) {
    // The reverse proxy asks here before issuing a certificate for a preview host.
    if (url.pathname === TLS_PATH) {
      const asked = previewHostOf(url.searchParams.get("domain") ?? "");
      const ok = asked !== null && (await lookup(asked)) !== null;
      res.writeHead(ok ? 200 : 404).end();
      return;
    }
    if (url.pathname === HEALTH_PATH) {
      const ok = await workerHealthy();
      res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" }).end(ok ? "ok" : "unavailable");
      return;
    }
    return sendPage(res, 404, "notFound");
  }
  const preview = await lookup(host);
  if (!preview) return sendPage(res, 404, "notFound");
  if (url.pathname === AUTH_PATH) return redeem(req, res, preview, url);
  if (!hasAccess(req, preview)) {
    if (req.method === "GET" || req.method === "HEAD") return redirectToApp(res, preview, req.url ?? "/");
    return sendPage(res, 401, "denied");
  }
  if (preview.kind === "live") return proxyLive(req, res, preview);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...BASE_HEADERS, allow: "GET, HEAD" }).end();
    return;
  }
  return serveStatic(req, res, preview, url);
}

/** Starts the preview server on PREVIEW_PORT; resolves once it listens. */
export async function startPreviewServer(): Promise<{ close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("[previews] request failed:", error);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    proxyUpgrade(req, socket, head).catch(() => socket.destroy());
  });
  server.headersTimeout = 20_000;
  // Uploads to an app may take long; idle sockets close by the server's own keep-alive timeout.
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(env().PREVIEW_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

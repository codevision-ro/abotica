/**
 * For tests only: a git smart HTTP server over HTTPS, `git http-backend` behind node:https, serving
 * the bare repositories under `root` at `/git/<name>.git`. Requests without the expected
 * Authorization are answered 401, as a provider does. `redirects` maps a path prefix to another one,
 * answered with a 302, to play a provider that moved a repository; `aliases` serves a path prefix as
 * another one.
 */
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

export type GitServer = {
  readonly port: number;
  /** Every request seen: method, path with query, and whether it carried the expected Authorization. */
  readonly requests: { method: string; url: string; authorized: boolean }[];
  close(): Promise<void>;
};

type GitServerOptions = {
  root: string;
  tls: { cert: string; key: string };
  authorization: string;
  redirects?: Record<string, string>;
  aliases?: Record<string, string>;
};

/** Runs git http-backend for one request (CGI) for `path` and streams its answer back. */
function serveCgi(root: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(path, "https://localhost");
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    // http-backend accepts pushes only from an authenticated user.
    REMOTE_USER: "agent",
    REQUEST_METHOD: req.method ?? "GET",
    PATH_INFO: decodeURIComponent(url.pathname.replace(/^\/git/, "")),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
  };
  const passed = {
    CONTENT_LENGTH: "content-length",
    HTTP_CONTENT_ENCODING: "content-encoding",
    GIT_PROTOCOL: "git-protocol",
  };
  for (const [name, header] of Object.entries(passed)) {
    const value = req.headers[header];
    if (typeof value === "string") env[name] = value;
  }
  const backend = spawn("git", ["http-backend"], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  req.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let headersDone = false;
  backend.stdout.on("data", (chunk: Buffer) => {
    if (headersDone) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    headersDone = true;
    let status = 200;
    for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    res.write(head.subarray(end + 4));
  });
  backend.stdout.on("end", () => res.end());
}

/** `url` with the first prefix of `map` it starts with replaced by its value; null when none matches. */
function replacePrefix(url: string, map: Record<string, string> = {}): string | null {
  const from = Object.keys(map).find((prefix) => url.startsWith(prefix));
  return from === undefined ? null : map[from]! + url.slice(from.length);
}

export async function startGitServer(options: GitServerOptions): Promise<GitServer> {
  const requests: GitServer["requests"] = [];
  const server = https.createServer({ cert: options.tls.cert, key: options.tls.key }, (req, res) => {
    const authorized = req.headers.authorization === options.authorization;
    requests.push({ method: req.method ?? "", url: req.url ?? "", authorized });
    if (!authorized) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' });
      return void res.end();
    }
    const url = req.url ?? "/";
    const redirect = replacePrefix(url, options.redirects);
    if (redirect) {
      res.writeHead(302, { location: redirect });
      return void res.end();
    }
    serveCgi(options.root, replacePrefix(url, options.aliases) ?? url, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

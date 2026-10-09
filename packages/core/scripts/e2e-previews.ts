import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { agents, conversations, db, previews, runs } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import {
  createAgentFromTemplate,
  createLivePreview,
  createProject,
  createTask,
  deleteProject,
  env,
  getSandboxStatus,
  issuePreviewTicket,
  listPreviews,
  type Preview,
  previewCookieName,
  previewDir,
  revokePreview,
  setDefaultUploadsRoot,
  setPreviewPublic,
  startTaskRun,
  sweepPreviews,
} from "../src/index";

/**
 * End-to-end check of previews: a specialist publishes a mockup folder (with a link to a file
 * outside it) and starts an app, then this script visits both the way a browser would, through the
 * worker's preview server: private access through a one-time ticket, cookies bound to their
 * preview, public access, links and paths that leave the copy, the reverse proxy's certificate
 * question, take-down and expiry. Needs the worker with its sandbox (docker compose) and a provider key.
 * Usage: pnpm --filter @abotica/core e2e:previews (E2E_PROVIDER and E2E_MODEL pick the model, default DeepSeek)
 */
const MODEL = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const TIMEOUT_MS = 10 * 60_000;
/** The preview server caches what it looked up this long. */
const LOOKUP_TTL_MS = 5_500;

// The worker keeps stored files (and preview copies) in the web app's uploads folder.
setDefaultUploadsRoot(path.resolve(import.meta.dirname, "../../../apps/web/.data/uploads"));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(label);
};

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** A request to the preview server for `<host>.<preview host>`, as a browser would send it. */
function visit(host: string, pathname: string, cookie?: string): Promise<Answer> {
  const base = new URL(env().PREVIEW_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(base.port || 80),
        path: pathname,
        headers: { host: `${host}.${base.host}`, ...(cookie ? { cookie } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Signs in to a private preview the way the app does: a ticket, traded for the preview's cookie. */
async function signIn(preview: Preview): Promise<{ answer: Answer; cookie: string; ticket: string }> {
  const ticket = issuePreviewTicket(preview.id);
  const answer = await visit(preview.host, `/__abotica/auth?ticket=${encodeURIComponent(ticket)}&return=/`);
  const set = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return { answer, cookie: set.split(";")[0] ?? "", ticket };
}

/** A websocket echo server, the minimal part of the protocol a dev server's live reload uses. */
const ECHO_SERVER = `
import socket, base64, hashlib, threading
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 8001)); s.listen()
def echo(c):
    while True:
        d = c.recv(4096)
        if not d: break
        c.sendall(d)
while True:
    c, _ = s.accept()
    head = c.recv(4096).decode()
    key = [l.split(":", 1)[1].strip() for l in head.split("\\r\\n") if l.lower().startswith("sec-websocket-key")][0]
    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    c.sendall(("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n").encode())
    threading.Thread(target=echo, args=(c,), daemon=True).start()
`;

/** Opens a websocket through the preview server and returns what comes back for `message`. */
function websocketEcho(host: string, message: string): Promise<{ status: string; echo: string }> {
  const base = new URL(env().PREVIEW_URL);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(base.port || 80) });
    let buffer = "";
    let status = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("websocket timeout")));
    socket.on("connect", () =>
      socket.write(
        [
          "GET /live HTTP/1.1",
          `Host: ${host}.${base.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!status && buffer.includes("\r\n\r\n")) {
        status = buffer.split("\r\n")[0] ?? "";
        buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
        socket.write(message);
      }
      if (status && buffer.includes(message)) {
        socket.end();
        resolve({ status, echo: buffer });
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ status, echo: buffer }));
  });
}

const status = await getSandboxStatus();
if (!status?.isolation) {
  console.error("The sandbox is not running: start the worker with docker compose and check Settings > Sandbox.");
  process.exit(1);
}

let projectId: string | null = null;
let agentId: string | null = null;
try {
  const specialist = await createAgentFromTemplate("template-software-engineer", { name: "E2E Preview developer" });
  agentId = specialist.id;
  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(eq(agents.id, specialist.id));
  const project = await createProject({
    name: `E2E Previews ${Date.now().toString(36)}`,
    memberIds: [specialist.id],
    managerAgentId: null,
  });
  projectId = project.id;
  const task = await createTask({
    title: "Show the bakery mockup and the app",
    projectId: project.id,
    assigneeAgentId: specialist.id,
    description: [
      "Do these steps in order, each exactly as written and in its own tool call. Do not add steps.",
      `1. shell_run: mkdir -p mockup/css && printf '<link rel="stylesheet" href="css/app.css"><h1>Crumb mockup</h1>' > mockup/index.html && printf 'h1{color:#b45309}' > mockup/css/app.css && ln -sf /etc/passwd mockup/secrets && echo ok`,
      `2. preview_publish with path "mockup" and title "Crumb mockup" (private).`,
      `3. shell_run: mkdir -p site && echo '<h1>Live Crumb</h1>' > site/index.html && cd site && (nohup python3 -m http.server 8000 --bind 0.0.0.0 > ../server.log 2>&1 &) && sleep 1 && curl -s localhost:8000 | head -n 1`,
      `4. preview_open with port 8000 and title "Crumb live" (private).`,
      "5. Set the task to done with both links as the result.",
    ].join("\n"),
  });
  const run = await startTaskRun(task.id);
  console.log(`run ${run.id}, task ${task.id}`);
  const deadline = Date.now() + TIMEOUT_MS;
  let finished = run;
  while (["queued", "running"].includes(finished.status)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for the run");
    await wait(3000);
    const [row] = await db.select().from(runs).where(eq(runs.id, run.id));
    if (!row) throw new Error("the run disappeared");
    finished = row;
  }
  check(finished.status === "succeeded", "the task run succeeded", finished.error);

  const made = await listPreviews({ projectId: project.id });
  const mockup = made.find((p) => p.kind === "static");
  const live = made.find((p) => p.kind === "live");
  check(
    Boolean(mockup && live),
    "the agent published the mockup and opened the app",
    made.map((p) => p.kind),
  );
  if (!mockup || !live) throw new Error("no previews to visit");
  check(!mockup.public && !live.public, "both previews are private");

  // Private: without access the visitor goes through the app.
  const anonymous = await visit(mockup.host, "/");
  check(
    anonymous.status === 302 && anonymous.headers.location?.startsWith(`${env().APP_URL}/preview/${mockup.id}`) === true,
    "a visitor without access is sent through the app",
    anonymous.headers.location,
  );

  const { answer, cookie, ticket } = await signIn(mockup);
  check(
    answer.status === 302 && cookie.startsWith(`${previewCookieName()}=`) && answer.headers.location === "/",
    "a ticket from the app is traded for the preview's cookie",
    answer.status,
  );
  const reused = await visit(mockup.host, `/__abotica/auth?ticket=${encodeURIComponent(ticket)}&return=/`);
  check(reused.status === 403, "a ticket works only once", reused.status);
  const forged = await visit(mockup.host, `/__abotica/auth?ticket=${encodeURIComponent(`${ticket.slice(0, -3)}abc`)}`);
  check(forged.status === 403, "a forged ticket is refused", forged.status);

  const page = await visit(mockup.host, "/", cookie);
  check(page.status === 200 && page.body.includes("Crumb mockup"), "the mockup opens with the cookie", page.status);
  check(page.headers["x-robots-tag"]?.includes("noindex") === true, "previews are kept out of search engines");
  const css = await visit(mockup.host, "/css/app.css", cookie);
  check(
    css.status === 200 && css.headers["content-type"]?.startsWith("text/css") === true,
    "its files are served with their type",
  );
  const link = await visit(mockup.host, "/secrets", cookie);
  check(
    link.status === 404 && !link.body.includes("root:"),
    "a link to a file outside the folder was not copied",
    link.status,
  );
  const traversal = await visit(mockup.host, "/%2e%2e/%2e%2e/%2e%2e/etc/passwd", cookie);
  check(traversal.status === 404 && !traversal.body.includes("root:"), "paths cannot leave the copy", traversal.status);

  const otherCookie = await visit(live.host, "/", cookie);
  check(otherCookie.status === 302, "a cookie opens only its own preview", otherCookie.status);

  // Live: the app in the container, through the worker.
  const liveAccess = await signIn(live);
  const app = await visit(live.host, "/", liveAccess.cookie);
  check(
    app.status === 200 && app.body.includes("Live Crumb"),
    "the live preview reaches the app in the container",
    app.status,
  );

  // Public: the link alone opens it.
  await setPreviewPublic(live.id, true, { actor: "e2e" });
  await wait(LOOKUP_TTL_MS);
  const open = await visit(live.host, "/");
  check(open.status === 200 && open.body.includes("Live Crumb"), "a public preview opens without signing in", open.status);

  // Websockets: what a dev server's live reload needs, through the same preview server.
  execFileSync("docker", ["exec", "-d", `abotica-ws-${live.workspaceKey}`, "python3", "-c", ECHO_SERVER]);
  await wait(1000);
  const socketPreview = await createLivePreview({
    owner: { projectId: project.id },
    workspaceKey: live.workspaceKey,
    port: 8001,
    title: "Echo",
    public: true,
    agentId: null,
    runId: null,
  });
  const ws = await websocketEcho(socketPreview.host, "hello-through-the-preview");
  check(
    ws.status.includes("101") && ws.echo.includes("hello-through-the-preview"),
    "websockets reach the app and come back",
    ws,
  );

  // The reverse proxy's certificate question, by name only.
  const base = new URL(env().PREVIEW_URL);
  const ask = (domain: string) =>
    new Promise<number>((resolve, reject) =>
      http
        .get({ host: "127.0.0.1", port: Number(base.port || 80), path: `/__abotica/tls?domain=${domain}` }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject),
    );
  check((await ask(`${live.host}.${base.hostname}`)) === 200, "certificates are allowed for existing previews");
  check((await ask(`aaaaaaaaaaaaaaaaaaaaaaaaaa.${base.hostname}`)) === 404, "and refused for other names");

  // Take-down and expiry.
  await revokePreview(mockup.id, { actor: "e2e" });
  await wait(LOOKUP_TTL_MS);
  check((await visit(mockup.host, "/", cookie)).status === 404, "a preview taken down stops at once");
  check((await stat(previewDir(mockup.id)).catch(() => null)) === null, "its copy is deleted");
  await db
    .update(previews)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(previews.id, live.id));
  await wait(LOOKUP_TTL_MS);
  check((await visit(live.host, "/")).status === 404, "an expired preview stops");
  await sweepPreviews();
  check(
    (await db.select().from(previews).where(eq(previews.id, live.id))).length === 0,
    "the sweep removes expired previews",
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  if (projectId) await deleteProject(projectId, { actor: "e2e" }).catch(() => undefined);
  if (agentId) {
    // Runs and conversations go with the agent.
    await db.delete(conversations).where(eq(conversations.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

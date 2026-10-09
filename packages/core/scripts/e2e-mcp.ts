import path from "node:path";
import { agents, db, mcpServers, runEvents, runs } from "@abotica/db";
import { asc, eq, isNotNull } from "@abotica/db/orm";
import { deleteConversation, getSandboxStatus, listFiles, setDefaultUploadsRoot, startRun } from "../src/index";

/**
 * End-to-end check of the bundled MCP servers: a real agent with no MCP assignment finds each one
 * through tool_search (they are global) and uses it: Parallel Search, Context7, Playwright in its
 * own workspace (a screenshot it then shares) and Scrapling past a Cloudflare challenge. The
 * "vision" scenario has the agent build a page, serve it in its workspace, open it in the browser
 * and look at the screenshot with file_read: it needs a model that sees images (the catalog lists
 * "image" among its input modalities), which the default model below does not. Needs the worker
 * running with the sandbox (docker compose), the sandbox image built, and a provider key.
 * Usage: E2E_PROVIDER=deepseek E2E_MODEL=deepseek-v4-flash pnpm --filter @abotica/core e2e:mcp
 * E2E_ONLY=parallel-search (or context7, playwright, scrapling, vision) runs one scenario.
 */
// Same default as the worker, which stores shared files where the web app serves them.
setDefaultUploadsRoot(path.resolve(import.meta.dirname, "../../../apps/web/.data/uploads"));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitRun(id: string) {
  for (let i = 0; i < 400; i++) {
    const [r] = await db.select().from(runs).where(eq(runs.id, id));
    if (r && !["queued", "running"].includes(r.status)) return r;
    await wait(1000);
  }
  throw new Error("timeout");
}

/**
 * Prints the run's tool calls and errors; returns the names of the tools it called, their inputs and
 * results as JSON, and the results by tool name.
 */
async function printRun(label: string, runId: string) {
  const result = await waitRun(runId);
  console.log(`${label}:`, result.status, result.error ?? "", "steps", result.steps, result.provider, result.model);
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
  const called: string[] = [];
  const inputs: string[] = [];
  const outputs: string[] = [];
  const results: { name: string; output: string }[] = [];
  for (const e of events) {
    for (const c of (e.data.toolCalls as { name: string; input: unknown }[] | undefined) ?? []) {
      called.push(c.name);
      inputs.push(JSON.stringify(c.input));
      console.log("  call", c.name, JSON.stringify(c.input).slice(0, 160));
    }
    for (const r of (e.data.toolResults as { name: string; output: unknown }[] | undefined) ?? []) {
      outputs.push(JSON.stringify(r.output));
      results.push({ name: r.name, output: JSON.stringify(r.output) });
      console.log("    ->", r.name, JSON.stringify(r.output).slice(0, 220));
    }
    if (e.type.endsWith("error")) console.log("  event", e.type, JSON.stringify(e.data).slice(0, 400));
  }
  console.log("  answer:", (result.output ?? "").slice(0, 300).replace(/\n/g, " "));
  return { result, called, inputs, outputs, results };
}

const status = await getSandboxStatus();
console.log("sandbox:", status?.isolation ?? "not running");
const bundled = await db.select().from(mcpServers).where(isNotNull(mcpServers.builtin));
for (const s of bundled)
  console.log(`bundled ${s.slug}: enabled ${s.enabled}, global ${s.global}, tools ${s.tools?.length ?? "none"}`);

const model = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const only = process.env.E2E_ONLY;
let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(ok ? "ok  " : "FAIL", label);
  if (!ok) failed = true;
};

const [agent] = await db
  .insert(agents)
  .values({
    slug: "e2e-mcp",
    name: "E2E MCP",
    ...model,
    // Workspace tools give the run a sandbox, where Playwright and Scrapling start.
    permissions: { shell_run: "allow", file_read: "allow", file_write: "allow", file_share: "allow" },
    systemPrompt: "You are a test agent. Always use tools when asked. Be brief.",
  })
  .returning();
const conversations: string[] = [];

async function scenario(key: string, input: string, expect: (r: Awaited<ReturnType<typeof printRun>>) => void) {
  if (only && only !== key) return;
  const run = await startRun({ agentId: agent!.id, trigger: "chat", input });
  conversations.push(run.conversationId!);
  const r = await printRun(key, run.id);
  check(r.result.status === "succeeded", `${key}: run succeeded`);
  check(r.called.includes("tool_search"), `${key}: found the tools with tool_search`);
  expect(r);
}

const prefixOf = (slug: string) => `${slug.replace(/[^a-zA-Z0-9]/g, "_")}__`;
const calledServer = (r: { called: string[] }, slug: string) => r.called.some((n) => n.startsWith(prefixOf(slug)));

try {
  await scenario(
    "parallel-search",
    "Search the web with the Parallel Search tools: what is the latest stable version of Node.js? Answer with the version only.",
    (r) => check(calledServer(r, "parallel-search"), "parallel-search: searched the web"),
  );
  await scenario(
    "context7",
    "Use the Context7 tools to look up how to define a route handler in the Next.js App Router. Answer in two sentences.",
    (r) => check(calledServer(r, "context7"), "context7: read the documentation"),
  );
  await scenario(
    "playwright",
    "With the Playwright browser tools, open https://example.com, take a screenshot of the page, then share the screenshot file with file_share. Tell me the page title.",
    async (r) => {
      check(calledServer(r, "playwright"), "playwright: used the browser");
      check(
        r.outputs.some((o) => o.includes("Example Domain")),
        "playwright: read the page",
      );
      check(r.called.includes("file_share"), "playwright: shared the screenshot");
    },
  );
  await scenario(
    "vision",
    "Write site/index.html: a page with a solid red background and the code QX-4271 in large white text. Serve the site folder on port 8000 in the background, open http://localhost:8000 with the Playwright browser tools, take a screenshot, then look at the screenshot with file_read. Tell me the background color and the code you see in it.",
    (r) => {
      check(
        r.inputs.some((i) => i.includes("site/index.html")),
        "vision: wrote the page",
      );
      check(
        r.results.some(
          (x) =>
            x.name.endsWith("browser_navigate") &&
            x.output.includes("localhost:8000") &&
            x.output.includes("Page Title") &&
            !x.output.includes("Blocked by the sandbox"),
        ),
        "vision: the browser opened the workspace's server",
      );
      check(!r.called.some((n) => n.endsWith("browser_run_code_unsafe")), "vision: no browser_run_code_unsafe workaround");
      check(r.called.includes("file_read"), "vision: looked at the screenshot with file_read");
      const answer = (r.result.output ?? "").toLowerCase();
      check(answer.includes("red") && answer.includes("qx-4271"), "vision: saw the color and the code");
    },
  );
  await scenario(
    "scrapling",
    "Use the Scrapling stealthy_fetch tool with solve_cloudflare set to true and extraction_type text to read https://nopecha.com/demo/cloudflare. Tell me whether you got past the security check and what the page says.",
    (r) => {
      check(calledServer(r, "scrapling"), "scrapling: fetched the page");
      check(
        r.outputs.some((o) => o.includes('\\"status\\": 200') || o.includes('"status":200')),
        "scrapling: passed Cloudflare (status 200)",
      );
    },
  );
  const shared = await Promise.all(conversations.map((id) => listFiles({ conversationId: id })));
  if (!only || only === "playwright") {
    check(
      shared.flat().some((f) => f.name.endsWith(".png")),
      "a PNG screenshot reached the user",
    );
  }
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  for (const id of conversations) await deleteConversation(id);
  await db.delete(agents).where(eq(agents.id, agent!.id));
  process.exit(failed ? 1 : 0);
}

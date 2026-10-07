import path from "node:path";
import { agents, db, messages, runEvents, runs } from "@abotica/db";
import { and, asc, eq, inArray, isNotNull, type SQL } from "@abotica/db/orm";
import type { UIMessage } from "ai";
import { inputPath } from "../src/agents/workspace-paths";
import {
  claimMessageFiles,
  createConversation,
  deleteConversation,
  deleteTask,
  fileIdFromUrl,
  getSandboxStatus,
  listFiles,
  readFileBytes,
  saveFile,
  setDefaultUploadsRoot,
  startRun,
} from "../src/index";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitRun(id: string) {
  for (let i = 0; i < 300; i++) {
    const [r] = await db.select().from(runs).where(eq(runs.id, id));
    if (r && !["queued", "running"].includes(r.status)) return r;
    await wait(1000);
  }
  throw new Error("timeout");
}

/** The first run matching `where`, once it exists. */
async function waitForRun(where: SQL | undefined) {
  for (let i = 0; i < 300; i++) {
    const [r] = await db.select().from(runs).where(where).orderBy(asc(runs.createdAt)).limit(1);
    if (r) return r;
    await wait(1000);
  }
  throw new Error("timeout");
}

const text = async (id: string) => new TextDecoder().decode((await readFileBytes(id)) ?? new Uint8Array());

/** Prints the tool calls and results of a run; returns the results. */
async function printRun(label: string, runId: string) {
  const result = await waitRun(runId);
  console.log(`${label}:`, result.status, result.error ?? "", "steps", result.steps, result.provider, result.model);
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
  for (const e of events) {
    const calls = (e.data.toolCalls as { name: string; input: unknown }[] | undefined) ?? [];
    for (const c of calls) console.log("  call", c.name, JSON.stringify(c.input).slice(0, 200));
  }
  const results = events.flatMap((e) =>
    ((e.data.toolResults as { name: string; output: unknown }[] | undefined) ?? []).map((r) => ({
      name: r.name,
      output: JSON.stringify(r.output),
    })),
  );
  for (const r of results) console.log("  ", r.name, r.output.slice(0, 300));
  for (const e of events.filter((e) => e.type.endsWith("error"))) console.log("  event", e.type, JSON.stringify(e.data));
  return { result, results };
}

/**
 * End-to-end check of the sandbox: a real agent runs commands, installs a package, hits a blocked
 * host and shares a file; then an orchestrator hands a user's file to another agent, which edits and
 * shares it, and the orchestrator gives the result to the user. Needs the worker running with the
 * sandbox (docker compose) and a provider key.
 * Usage: E2E_PROVIDER=deepseek E2E_MODEL=deepseek-v4-flash pnpm --filter @abotica/core e2e:sandbox
 * E2E_ONLY=delegation (or sandbox) runs one scenario.
 */
// Same default as the worker, which stores shared files where the web app serves them.
setDefaultUploadsRoot(path.resolve(import.meta.dirname, "../../../apps/web/.data/uploads"));

const status = await getSandboxStatus();
console.log("sandbox:", status?.isolation ?? "not running");
if (!status?.isolation) {
  console.error("The sandbox is not running: start the worker with docker compose and check Settings > Sandbox.");
  process.exit(1);
}

const model = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const only = process.env.E2E_ONLY;
const workspaceTools = {
  shell_run: "allow",
  file_read: "allow",
  file_write: "allow",
  file_edit: "allow",
  file_share: "allow",
} as const;

const created = { agents: [] as string[], conversations: [] as string[], tasks: [] as string[] };
let failed = false;
const check = (ok: boolean, label: string) => {
  console.log(ok ? "ok  " : "FAIL", label);
  if (!ok) failed = true;
};

async function sandboxScenario() {
  const [agent] = await db
    .insert(agents)
    .values({
      slug: "e2e-sandbox",
      name: "E2E sandbox",
      ...model,
      permissions: workspaceTools,
      systemPrompt: "You are a test agent. Always use tools when asked. Be brief.",
    })
    .returning();
  created.agents.push(agent!.id);
  const run = await startRun({
    agentId: agent!.id,
    trigger: "chat",
    input: [
      "Do these steps with your tools, one shell_run per step, and report each exit code:",
      "1. Install the Python package `six` into a new virtualenv: python3 -m venv venv && venv/bin/pip install six",
      "2. Run: venv/bin/python -c 'import six; print(six.__version__)'",
      "3. Run: curl -sS -o /dev/null -w '%{http_code}' https://example.com",
      "4. Use file_write to create report.txt containing exactly: sandbox works",
      "5. Use file_share to share report.txt.",
    ].join("\n"),
  });
  created.conversations.push(run.conversationId!);
  const { result, results } = await printRun("run", run.id);

  const shell = results.filter((r) => r.name === "shell_run").map((r) => r.output);
  check(result.status === "succeeded", "run succeeded");
  check(
    shell.some((o) => o.includes("Successfully installed six")),
    "pip install through the registry policy",
  );
  check(
    shell.some((o) => /"stdout":"1\.\d+\.\d+/.test(o)),
    "installed package imports",
  );
  check(!shell.some((o) => o.includes('"stdout":"200"')), "example.com is not reachable");

  const [file] = await listFiles({ runId: run.id });
  check((file && (await text(file.id)).trim()) === "sandbox works", `shared file stored (${file?.name ?? "none"})`);
  check(file?.conversationId === run.conversationId, "shared file belongs to the conversation");
}

async function delegationScenario() {
  const [orchestrator, delegate] = await db
    .insert(agents)
    .values([
      {
        slug: "e2e-orchestrator",
        name: "E2E orchestrator",
        ...model,
        isOrchestrator: true,
        permissions: { ...workspaceTools, delegate_task: "allow", task_get: "allow", task_update: "allow" },
        systemPrompt: "You are a test orchestrator. Always use tools when asked. Be brief.",
      },
      {
        slug: "e2e-delegate",
        name: "E2E delegate",
        ...model,
        permissions: { ...workspaceTools, task_get: "allow", task_update: "allow" },
        systemPrompt: "You are a test agent. Always use tools when asked. Be brief.",
      },
    ])
    .returning();
  created.agents.push(orchestrator!.id, delegate!.id);

  // The user's message with an attached file, as the web chat sends it.
  const conversation = await createConversation({
    agentId: orchestrator!.id,
    channel: "internal",
    title: "E2E delegation",
  });
  created.conversations.push(conversation.id);
  const upload = await saveFile({
    name: "notes.txt",
    data: new TextEncoder().encode("first line\n"),
    source: "user",
    owner: null,
  });
  const message = await claimMessageFiles(
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: [
            `I attached notes.txt; it is in your workspace at ${inputPath(upload)}.`,
            "1. Call delegate_task for agent e2e-delegate with a new task titled 'Sign the notes' and pass that path in files. Description: the file notes.txt is in your workspace inputs; append the line 'signed by delegate' to it, share the edited file with file_share, then set the task to review.",
            "2. When the task's result arrives, give me the file the delegate produced with file_share.",
          ].join("\n"),
        },
        { type: "file", url: `/api/files/${upload.id}`, mediaType: "text/plain", filename: "notes.txt" },
      ],
    } satisfies UIMessage,
    conversation.id,
  );
  const run = await startRun({ agentId: orchestrator!.id, trigger: "chat", conversationId: conversation.id, message });
  const first = await printRun("orchestrator", run.id);
  check(first.result.status === "succeeded", "orchestrator run succeeded");

  const delegated = await waitForRun(eq(runs.parentRunId, run.id));
  if (delegated.taskId) created.tasks.push(delegated.taskId);
  const taskRun = await printRun("delegate", delegated.id);
  check(taskRun.result.status === "succeeded", "delegate run succeeded");
  const taskFiles = delegated.taskId ? await listFiles({ taskId: delegated.taskId }) : [];
  const handed = taskFiles.find((f) => f.runId === run.id);
  check(handed?.name === "notes.txt", "the user's file was handed over to the task");
  const produced = taskFiles.find((f) => f.runId === delegated.id);
  check(Boolean(produced && (await text(produced.id)).includes("signed by delegate")), "the delegate shared its edit");

  const reported = await waitForRun(and(eq(runs.parentRunId, delegated.id), eq(runs.conversationId, conversation.id)));
  const final = await printRun("report", reported.id);
  check(final.result.status === "succeeded", "report run succeeded");
  const notices = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user")));
  const reportParts = notices.flatMap((m) => m.parts as { type: string; url?: string }[]);
  check(
    reportParts.some((p) => p.type === "file" && p.url && fileIdFromUrl(p.url) === produced?.id),
    "the report carries the produced file",
  );
  const shared = await listFiles({ runId: reported.id, conversationId: conversation.id });
  const contents = await Promise.all(shared.map((f) => text(f.id)));
  check(
    contents.some((c) => c.includes("signed by delegate")),
    `the orchestrator gave the user the file (${shared.map((f) => f.name).join(", ") || "none"})`,
  );
}

try {
  if (only !== "delegation") await sandboxScenario();
  if (only !== "sandbox") await delegationScenario();
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  for (const id of created.tasks) await deleteTask(id);
  // Task runs start conversations of their own.
  const runConversations = created.agents.length
    ? await db
        .selectDistinct({ id: runs.conversationId })
        .from(runs)
        .where(and(inArray(runs.agentId, created.agents), isNotNull(runs.conversationId)))
    : [];
  for (const id of new Set([...created.conversations, ...runConversations.map((r) => r.id!)])) {
    await deleteConversation(id);
  }
  for (const id of created.agents) await db.delete(agents).where(eq(agents.id, id));
  process.exit(failed ? 1 : 0);
}

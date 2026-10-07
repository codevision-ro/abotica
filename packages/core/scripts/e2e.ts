import { agents, approvals, db, memories, messages, runEvents, runs, tasks } from "@abotica/db";
import { and, asc, eq, gte } from "@abotica/db/orm";
import { ANY_PROVIDER, decideApproval, embedText, startRun } from "../src/index";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitRun(id: string) {
  for (let i = 0; i < 120; i++) {
    const [r] = await db.select().from(runs).where(eq(runs.id, id));
    if (r && !["queued", "running"].includes(r.status)) return r;
    await wait(1000);
  }
  throw new Error("timeout");
}

/** End-to-end check of the agent loop: tools, approval pause, resume. Needs the worker running.
 * Usage: E2E_PROVIDER=deepseek E2E_MODEL=deepseek-v4-flash pnpm --filter @abotica/core e2e */
const startedAt = new Date();
const vec = await embedText("test embedding", ANY_PROVIDER);
console.log("embedding dims:", vec?.length ?? null);

const [agent] = await db
  .insert(agents)
  .values({
    slug: "e2e-ollama",
    name: "E2E",
    provider: process.env.E2E_PROVIDER ?? "deepseek",
    model: process.env.E2E_MODEL ?? "deepseek-v4-flash",
    permissions: { memory_save: "allow", memory_search: "allow", task_create: "ask", task_list: "allow" },
    systemPrompt: "You are a test agent. Always use tools when asked. Be brief.",
  })
  .returning();

try {
  const run = await startRun({
    agentId: agent!.id,
    trigger: "chat",
    input:
      "Use memory_save with scope global to save: 'User prefers short reports'. Then call task_create with title 'E2E test task'.",
  });
  const r1 = await waitRun(run.id);
  console.log("run1:", r1.status, r1.error ?? "", "steps", r1.steps, "model", r1.provider, r1.model);
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.id));
  for (const e of events)
    console.log(
      "  event",
      e.type,
      JSON.stringify({ ...e.data, reasoning: String(e.data.reasoning ?? "").slice(-300) }).slice(0, 900),
    );
  const mem = await db
    .select()
    .from(memories)
    .where(and(eq(memories.source, "agent"), gte(memories.createdAt, startedAt)));
  console.log(
    "memories saved:",
    mem.map((m) => `${m.content} [emb ${m.embedding ? "yes" : "no"}]`),
  );
  const pending = await db.select().from(approvals).where(eq(approvals.runId, run.id));
  console.log(
    "approvals:",
    pending.map((a) => `${a.toolName} ${a.status}`),
  );
  if (pending[0]) {
    const res = await decideApproval(pending[0].id, true);
    console.log("decided, continued:", res?.continued);
    const [cont] = await db.select().from(runs).where(eq(runs.parentRunId, run.id));
    const r2 = await waitRun(cont!.id);
    console.log("run2:", r2.status, r2.error ?? "", "output:", r2.output?.slice(0, 200));
    const created = await db.select().from(tasks).where(eq(tasks.createdBy, "agent:e2e-ollama"));
    console.log(
      "tasks created:",
      created.map((t) => t.title),
    );
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, r1.conversationId!))
      .orderBy(asc(messages.createdAt));
    console.log(
      "messages:",
      msgs.length,
      msgs.map(
        (m) =>
          `${m.role}:${(m.parts as { type: string; state?: string }[]).map((p) => p.type + (p.state ? `(${p.state})` : "")).join(",")}`,
      ),
    );
  }
} finally {
  await db.delete(tasks).where(eq(tasks.createdBy, "agent:e2e-ollama"));
  await db.delete(memories).where(and(eq(memories.source, "agent"), gte(memories.createdAt, startedAt)));
  await db.delete(agents).where(eq(agents.id, agent!.id));
  process.exit(0);
}

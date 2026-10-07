import { agents, conversations, db, journals, memories, messages, runs, tasks } from "@abotica/db";
import { and, asc, eq, gte, inArray } from "@abotica/db/orm";
import {
  contextMemories,
  createAgentFromTemplate,
  createConversation,
  createProject,
  deleteConversation,
  deleteProject,
  getOrchestrator,
  isDelegationReport,
  recentJournals,
  searchMemories,
  startRun,
} from "../src/index";

/**
 * End-to-end check of a project team: the super agent delegates to the project's manager, the manager
 * to a specialist (or does it itself), and the reports come back up both levels. Also checks that what
 * the specialist knows of another project does not reach this one. Needs the worker running.
 * Usage: pnpm --filter @abotica/core e2e:team (E2E_PROVIDER and E2E_MODEL pick the model, default DeepSeek;
 * the super agent gets it through its conversation, so its own configuration is not touched)
 */
const TIMEOUT_MS = 12 * 60_000;
const MODEL = { provider: process.env.E2E_PROVIDER ?? "deepseek", model: process.env.E2E_MODEL ?? "deepseek-v4-flash" };
const MARKER = `leak-check-${Date.now().toString(36)}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date();
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const orchestrator = await getOrchestrator();
const createdAgents: string[] = [];
const createdProjects: string[] = [];
let conversationId: string | null = null;

/** Runs of the given conversations, oldest first. */
const runsOf = (ids: string[]) =>
  ids.length ? db.select().from(runs).where(inArray(runs.conversationId, ids)).orderBy(asc(runs.createdAt)) : [];

/** Done when nothing is active anymore and the super agent's conversation got a report and answered it. */
/** True once the chain is done; throws as soon as a run fails, instead of waiting for the timeout. */
async function settled(): Promise<boolean> {
  const [failed] = await db
    .select({ id: runs.id, error: runs.error })
    .from(runs)
    .where(and(gte(runs.createdAt, startedAt), eq(runs.status, "failed")))
    .limit(1);
  if (failed) throw new Error(`run ${failed.id} failed: ${failed.error ?? "no error recorded"}`);
  const active = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(gte(runs.createdAt, startedAt), inArray(runs.status, ["queued", "running"])));
  if (active.length) return false;
  const all = await runsOf([conversationId!]);
  const reported = (await db.select().from(messages).where(eq(messages.conversationId, conversationId!))).some((m) =>
    isDelegationReport(m.metadata),
  );
  return reported && all.length >= 2 && all.every((r) => !["queued", "running"].includes(r.status));
}

try {
  const specialist = await createAgentFromTemplate("template-web-developer", { name: "E2E Web developer" });
  createdAgents.push(specialist.id);
  const project = await createProject({
    name: `E2E Team ${Date.now().toString(36)}`,
    description: "A small company website for a bakery called Crumb.",
    goals: "A homepage that ranks for 'artisan bakery'.",
    memberIds: [specialist.id],
  });
  createdProjects.push(project.id);
  const manager = project.managerAgentId!;
  createdAgents.push(manager);
  check(Boolean(manager) && manager !== specialist.id, "project_create made a manager from the template");

  // Another project the specialist works on, with memory and a journal that must stay there.
  const other = await createProject({
    name: `E2E Other ${Date.now().toString(36)}`,
    memberIds: [specialist.id],
    managerAgentId: null,
  });
  createdProjects.push(other.id);
  await db.insert(memories).values({
    scope: "project",
    projectId: other.id,
    agentId: specialist.id,
    content: `Secret of the other project: ${MARKER}`,
    source: "agent",
  });
  await db.insert(journals).values({
    agentId: specialist.id,
    projectId: other.id,
    day: new Date().toISOString().slice(0, 10),
    summary: `Worked on the other project: ${MARKER}`,
  });

  await db
    .update(agents)
    .set({ ...MODEL, fallbacks: [] })
    .where(inArray(agents.id, [manager, specialist.id]));
  const conversation = await createConversation({ agentId: orchestrator.id, channel: "internal", title: "E2E team" });
  conversationId = conversation.id;
  await db.update(conversations).set({ modelOverride: MODEL }).where(eq(conversations.id, conversation.id));

  const run = await startRun({
    agentId: orchestrator.id,
    trigger: "chat",
    conversationId,
    input: `In the project "${project.name}" (id ${project.id}): we need the HTML <head> of the homepage, with a <title> and a meta description for an artisan bakery called Crumb. This is web developer work: the project's manager should have the team's web developer write it and review it. Get it done through the project and tell me the result.`,
  });
  console.log(`super agent run ${run.id}, conversation ${conversationId}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (!(await settled())) {
    if (Date.now() > deadline) throw new Error("timeout waiting for the delegation chain");
    await wait(3000);
  }

  // Level 1: the super agent delegated to the manager, in the project.
  const superRuns = await runsOf([conversationId]);
  const topTasks = await db
    .select()
    .from(tasks)
    .where(
      inArray(
        tasks.delegatedByRunId,
        superRuns.map((r) => r.id),
      ),
    );
  check(topTasks.length > 0, "super agent delegated a task");
  check(
    topTasks.every((t) => t.assigneeAgentId === manager && t.projectId === project.id),
    "super agent's tasks went to the manager, in the project",
  );

  // Level 2: the manager's task runs and what they delegated.
  const managerRuns = await db
    .select()
    .from(runs)
    .where(
      inArray(
        runs.taskId,
        topTasks.map((t) => t.id),
      ),
    );
  const managerConversations = [...new Set(managerRuns.flatMap((r) => (r.conversationId ? [r.conversationId] : [])))];
  const subTasks = managerRuns.length
    ? await db
        .select()
        .from(tasks)
        .where(
          inArray(
            tasks.delegatedByRunId,
            (await runsOf(managerConversations)).map((r) => r.id),
          ),
        )
    : [];
  if (subTasks.length) {
    console.log(`manager delegated ${subTasks.length} subtask(s)`);
    check(
      subTasks.every((t) => t.assigneeAgentId === specialist.id && t.projectId === project.id),
      "manager delegated to the specialist, in the project",
    );
    const managerMessages = await db.select().from(messages).where(inArray(messages.conversationId, managerConversations));
    check(
      managerMessages.some((m) => isDelegationReport(m.metadata)),
      "the specialist's report came back to the manager's task conversation",
    );
    check(
      subTasks.every((t) => t.reportedAt !== null),
      "every subtask was reported",
    );
  } else {
    console.log("manager did the work itself (no subtasks)");
  }
  check(
    topTasks.every((t) => t.reportedAt !== null),
    "the manager's task was reported to the super agent",
  );
  const [refreshed] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, topTasks[0]?.id ?? project.id));
  console.log(`manager's task status: ${refreshed?.status}; output: ${refreshed?.output?.slice(0, 300)}`);
  const last = superRuns.at(-1);
  console.log(`super agent's last run: ${last?.status}; output: ${last?.output?.slice(0, 400)}`);
  check(last?.status === "succeeded", "the super agent answered the report");

  // Isolation: the specialist's view of this project never includes the other project.
  const seen = await contextMemories(specialist.id, project.id);
  const searched = await searchMemories(MARKER, { agentId: specialist.id, projectId: project.id });
  const journal = await recentJournals(specialist.id, project.id, 30);
  check(
    ![...seen.project, ...seen.agent, ...seen.global].some((m) => m.content.includes(MARKER)),
    "context memory has nothing from the other project",
  );
  check(!searched.some((m) => m.content.includes(MARKER)), "memory search has nothing from the other project");
  check(!journal.some((j) => j.summary.includes(MARKER)), "journals have nothing from the other project");
  const specialistRuns = await db
    .select({ output: runs.output, input: runs.input })
    .from(runs)
    .where(and(eq(runs.agentId, specialist.id), gte(runs.createdAt, startedAt)));
  check(
    !specialistRuns.some((r) => `${r.input}${r.output}`.includes(MARKER)),
    "the specialist's runs never mention the other project",
  );
  check(
    (await contextMemories(specialist.id, other.id)).project.some((m) => m.content.includes(MARKER)),
    "the other project's memory is still visible inside the other project",
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  // The super agent's runs outlive its conversation (set null), so they go first.
  if (conversationId) {
    await db.delete(runs).where(and(eq(runs.conversationId, conversationId), eq(runs.agentId, orchestrator.id)));
    await deleteConversation(conversationId);
  }
  for (const id of createdProjects) await deleteProject(id, { actor: "e2e" }).catch(() => undefined);
  if (createdAgents.length) {
    await db.delete(conversations).where(inArray(conversations.agentId, createdAgents));
    await db.delete(agents).where(inArray(agents.id, createdAgents));
  }
  await db.delete(memories).where(and(eq(memories.source, "agent"), gte(memories.createdAt, startedAt)));
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

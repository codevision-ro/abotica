import { agents, conversations, db, projects, runs, tasks } from "@abotica/db";
import { inArray, like, or } from "@abotica/db/orm";
import { cancelConversationRuns, deleteConversation, deleteProject, deleteTask } from "../src/index";

/**
 * Removes what company scenarios left behind with E2E_KEEP=1 (or after a crash): the "E2E Company"
 * projects, the agents they created, the scenario conversations ("E2E ..." titles), their runs and tasks.
 * Every query is narrowed by a non-empty list of those ids: nothing matched means nothing is touched, never
 * a query without a filter.
 * Usage: pnpm --filter @abotica/core e2e:company:sweep [--dry]
 */
const projectIds = (await db.select({ id: projects.id }).from(projects).where(like(projects.name, "E2E Company %"))).map(
  (p) => p.id,
);
const agentIds = (
  await db
    .select({ id: agents.id })
    .from(agents)
    .where(or(like(agents.slug, "e2e-company-%"), like(agents.slug, "e2e-writer%"), like(agents.slug, "e2e-researcher%")))
).map((a) => a.id);
// The super agent is not the harness's, but its scenario conversations are.
const scenarioConversations = await db
  .select({ id: conversations.id, agentId: conversations.agentId })
  .from(conversations)
  .where(like(conversations.title, "E2E %"));
const ownConversations = agentIds.length
  ? await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.agentId, agentIds))
  : [];
const conversationIds = [...new Set([...scenarioConversations, ...ownConversations].map((c) => c.id))];

const runFilters = [
  projectIds.length ? inArray(runs.projectId, projectIds) : null,
  agentIds.length ? inArray(runs.agentId, agentIds) : null,
  conversationIds.length ? inArray(runs.conversationId, conversationIds) : null,
].filter((f) => f !== null);
const runIds = runFilters.length
  ? (
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(or(...runFilters))
    ).map((r) => r.id)
  : [];
const taskFilters = [
  projectIds.length ? inArray(tasks.projectId, projectIds) : null,
  runIds.length ? inArray(tasks.delegatedByRunId, runIds) : null,
].filter((f) => f !== null);
const taskIds = taskFilters.length
  ? (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(or(...taskFilters))
    ).map((t) => t.id)
  : [];

const found = `${projectIds.length} projects, ${agentIds.length} agents, ${taskIds.length} tasks, ${runIds.length} runs, ${conversationIds.length} conversations`;
// --dry shows what it would remove, and removes nothing.
if (process.argv.includes("--dry")) {
  console.log(`would remove ${found}`);
  process.exit(0);
}
for (const id of conversationIds) await cancelConversationRuns(id, "E2E sweep", "cancelled_by_user");
for (const id of projectIds) await deleteProject(id, { actor: "e2e" }).catch((e: unknown) => console.warn(String(e)));
for (const id of taskIds) await deleteTask(id).catch(() => {});
if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
for (const id of conversationIds) await deleteConversation(id).catch(() => {});
if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
console.log(`removed ${found}`);
process.exit(0);

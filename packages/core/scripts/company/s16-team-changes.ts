import { agents, db, messages, projectAgents, runEvents, runs, tasks } from "@abotica/db";
import { and, eq, gte, inArray, sql } from "@abotica/db/orm";
import { createAgentFromTemplate, saveMemory, startRun } from "../../src/index";
import type { Harness } from "../e2e-company";

const MARKER = "ZEBRA-4417";

type StepData = { text?: string; toolCalls?: { name: string; input?: unknown }[] };

/** The tool calls the runs made, from their step events. */
async function toolCalls(runIds: string[]): Promise<{ name: string; input?: unknown }[]> {
  if (!runIds.length) return [];
  const steps = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .where(and(inArray(runEvents.runId, runIds), eq(runEvents.type, "step")));
  return steps.flatMap(({ data }) => (data as StepData).toolCalls ?? []);
}

/** Every run in the conversation has ended (and at least `min` ran). */
async function settledConversation(conversationId: string, min: number) {
  const rows = await db.select().from(runs).where(eq(runs.conversationId, conversationId));
  return rows.length >= min && rows.every((r) => ["succeeded", "failed", "cancelled"].includes(r.status)) ? rows : null;
}

/**
 * S16: team changes. A manager finds a specialist the team lacks (agent_list), adds it (team_add) and
 * delegates to it. The super agent does a small step inside the project itself (work_in_project): a task
 * of its own, run in the project, reported back to the chat. And it reads a project's team memory through
 * memory_search with the projectId.
 */
export default async function teamChanges(h: Harness): Promise<void> {
  // A manager adds a specialist the team lacks, then delegates to it.
  const designer = await createAgentFromTemplate("template-product-designer", { name: "E2E Designer", actor: "e2e" });
  h.track.agent(designer.id);
  await db
    .update(agents)
    .set({ ...h.model, fallbacks: [] })
    .where(eq(agents.id, designer.id));
  const from = await h.delegatorRun({ agentId: h.orchestrator.id });
  const managerTask = await h.delegate({
    to: h.manager,
    from,
    title: "Logo colour",
    description: `Crumb needs one colour for its logo, chosen by a product designer. Nobody on your team designs: find the specialist ${designer.slug} with agent_list, add them to the team with team_add, and delegate to them a task asking for one colour name. When their result comes back, finish your task with that colour as the output.`,
  });
  await h.waitFor("the designer on the team", async () => {
    const [row] = await db
      .select()
      .from(projectAgents)
      .where(and(eq(projectAgents.projectId, h.project.id), eq(projectAgents.agentId, designer.id)));
    return row;
  });
  h.check(true, "a project_agents row joins the designer to the team");
  const delegated = await h.waitFor("a task delegated to the designer", async () => {
    const [row] = await db
      .select({ id: tasks.id, delegatedBy: runs.agentId })
      .from(tasks)
      .innerJoin(runs, eq(runs.id, tasks.delegatedByRunId))
      .where(and(eq(tasks.assigneeAgentId, designer.id), eq(tasks.projectId, h.project.id)));
    return row;
  });
  h.check(delegated.delegatedBy === h.manager.id, "the manager delegated to the designer (delegate_task)");
  const managerRuns = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, managerTask.id));
  const managerTools = (await toolCalls(managerRuns.map((r) => r.id))).map((c) => c.name);
  h.check(
    managerTools.includes("agent_list") && managerTools.includes("team_add"),
    `the manager used agent_list and team_add (${[...new Set(managerTools)].join(", ")})`,
  );

  // The super agent does a small step inside the project itself.
  const chat = await h.superConversation("E2E work in project");
  const asked = new Date();
  await startRun({
    agentId: h.orchestrator.id,
    trigger: "chat",
    conversationId: chat,
    input: `In project ${h.project.name} (id ${h.project.id}), do this small step yourself with work_in_project, without delegating: write the single line "Crumb opens at 7" as your output. Then tell me what it produced.`,
  });
  const own = await h.waitFor("the super agent's task in the project", async () => {
    const [row] = await db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.assigneeAgentId, h.orchestrator.id), eq(tasks.projectId, h.project.id), gte(tasks.createdAt, asked)),
      );
    return row;
  });
  h.track.task(own.id);
  const ownRun = await h.waitFor("the run of the super agent's task", async () => {
    const [row] = await db.select().from(runs).where(eq(runs.taskId, own.id));
    return row;
  });
  h.check(ownRun.projectId === h.project.id, "the super agent's own task runs in the project");
  await h.waitFor("the report of the super agent's task in the chat", async () => {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, chat),
          sql`${messages.metadata}->'tasks' @> ${JSON.stringify([{ id: own.id }])}::jsonb`,
        ),
      );
    return rows[0];
  });
  h.check(true, "the result came back to the chat as a report");
  await h.waitFor("the chat to finish", () => settledConversation(chat, 2));

  // The super agent reads a project's team memory with memory_search and its projectId.
  await saveMemory(
    {
      scope: "project",
      projectId: h.project.id,
      content: `The code word for the bakery's supplier orders is ${MARKER}.`,
      origin: "owner",
      source: "user",
    },
    { actor: "e2e" },
  );
  const memoryChat = await h.superConversation("E2E team memory");
  await startRun({
    agentId: h.orchestrator.id,
    trigger: "chat",
    conversationId: memoryChat,
    input: `What is the code word for supplier orders in project ${h.project.name}? It is in that project's team memory: search it with memory_search and projectId ${h.project.id}, and answer with the code word.`,
  });
  const memoryRuns = await h.waitFor("the memory question to be answered", () => settledConversation(memoryChat, 1));
  const searches = (await toolCalls(memoryRuns.map((r) => r.id))).filter((c) => c.name === "memory_search");
  h.check(
    searches.some((c) => (c.input as { projectId?: string } | undefined)?.projectId === h.project.id),
    "memory_search was called with the project's id",
  );
  h.check(
    memoryRuns.some((r) => r.output?.includes(MARKER)),
    `the super agent's answer contains the team memory marker ${MARKER}`,
  );
}

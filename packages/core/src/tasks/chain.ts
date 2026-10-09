/**
 * The chain of command above a task: who gave it (the agent whose run delegated it, in that run's
 * conversation) and on up to the user. Questions, deadlines, quiet tasks, dependency alerts and
 * failures all go up this way. Work a schedule or trigger fired goes to the agent above its assignee
 * (automation-target.ts): a manager in its project's inbox conversation, the super agent where the user
 * talks to it (superAgentInbox); a manager working outside any task answers to the super agent, and the
 * super agent to the user.
 */
import { agents, conversations, db, runs, tasks } from "@abotica/db";
import { and, desc, eq, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { getOrchestrator, type RunTrigger } from "../runs/runs";
import { superAgentInbox } from "../runs/super-agent-inbox";
import { reportTargetAgent } from "./automation-target";

type Agent = typeof agents.$inferSelect;

/**
 * The level above a task: an agent, with the conversation it works in, the run that delegated the task
 * (for work a schedule or trigger fired, the task's latest run), the agent's own task (null outside one)
 * and the trigger and project its runs there have; or the user, with the conversation that reaches them
 * (null: notifications only).
 */
export type Superior =
  | {
      kind: "agent";
      agent: Agent;
      conversationId: string;
      taskId: string | null;
      runId: string;
      trigger: RunTrigger;
      projectId: string | null;
    }
  | { kind: "user"; conversationId: string | null };

const USER: Superior = { kind: "user", conversationId: null };

/** A run that answers a person in its conversation: the user stands right above it. */
const answersPerson = (trigger: RunTrigger) => trigger === "chat" || trigger === "telegram";

/** The trigger of the runs a notice starts for work a schedule or trigger fired: the automation's. */
const automationTrigger = (trigger: RunTrigger): RunTrigger =>
  trigger === "schedule" || trigger === "webhook" || trigger === "event" ? trigger : "task";

/**
 * The manager's conversation for what reaches it about its project outside a delegation (questions on
 * work a schedule or trigger fired): one internal conversation per project, found or made under a lock.
 */
async function managerInbox(manager: Agent, projectId: string): Promise<string> {
  const externalId = `inbox:${projectId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbox:${manager.id}:${externalId}`}))`);
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.agentId, manager.id),
          eq(conversations.channel, "internal"),
          eq(conversations.externalId, externalId),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const [created] = await tx
      .insert(conversations)
      .values({ agentId: manager.id, channel: "internal", externalId, projectId, title: `Inbox: ${manager.name}` })
      .returning({ id: conversations.id });
    return created!.id;
  });
}

/** The super agent where the user talks to it, for what goes up about a project's work. */
async function superAgentLevel(projectId: string | null, runId: string): Promise<Superior> {
  const [orchestrator, inbox] = await Promise.all([getOrchestrator(), superAgentInbox(projectId)]);
  return {
    kind: "agent",
    agent: orchestrator,
    conversationId: inbox.id,
    taskId: null,
    runId,
    trigger: inbox.channel === "telegram" ? "telegram" : "chat",
    projectId: null,
  };
}

/** Work a schedule or trigger fired: the agent above its assignee; the user when nothing ran yet. */
async function automationSuperior(task: typeof tasks.$inferSelect): Promise<Superior> {
  const [above, [last]] = await Promise.all([
    reportTargetAgent(task),
    db
      .select({ id: runs.id, trigger: runs.trigger })
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(desc(runs.createdAt))
      .limit(1),
  ]);
  if (!above || !last) return USER;
  if (above.target === "orchestrator" || !task.projectId) return superAgentLevel(task.projectId, last.id);
  return {
    kind: "agent",
    agent: above.agent,
    conversationId: await managerInbox(above.agent, task.projectId),
    taskId: null,
    runId: last.id,
    trigger: automationTrigger(last.trigger),
    projectId: task.projectId,
  };
}

/** Whoever gave the task: its delegator, or the user when no agent stands above it. */
export async function superiorOf(taskId: string): Promise<Superior> {
  const [row] = await db
    .select({ task: tasks, run: runs, agent: agents })
    .from(tasks)
    .leftJoin(runs, eq(runs.id, tasks.delegatedByRunId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(tasks.id, taskId));
  if (!row) throw new UserError("tasks.errors.notFound");
  const { task, run, agent } = row;
  if (run?.conversationId && agent) {
    return {
      kind: "agent",
      agent,
      conversationId: run.conversationId,
      taskId: run.taskId,
      runId: run.id,
      trigger: run.trigger,
      projectId: run.projectId,
    };
  }
  return task.reportsUp ? automationSuperior(task) : USER;
}

/**
 * The level above an agent level: whoever gave its own task; outside a task, the user it answers in a
 * chat, or for a manager working on its own (an inbox), the super agent.
 */
async function levelAbove(level: Extract<Superior, { kind: "agent" }>, seen: Set<string>): Promise<Superior> {
  if (level.taskId && !seen.has(level.taskId)) {
    seen.add(level.taskId);
    return superiorOf(level.taskId);
  }
  if (level.agent.kind === "manager" && !answersPerson(level.trigger)) {
    return superAgentLevel(level.projectId, level.runId);
  }
  return USER;
}

/**
 * The levels above the task, nearest first, up to `max` of them; the walk ends at the user, who is always
 * the last level when it is reached.
 */
export async function chainOfCommand(taskId: string, max = 4): Promise<Superior[]> {
  const levels: Superior[] = [];
  const seen = new Set([taskId]);
  let level = await superiorOf(taskId);
  for (;;) {
    levels.push(level);
    if (level.kind === "user" || levels.length >= max) return levels;
    level = await levelAbove(level, seen);
  }
}

/** The agents of a chain of command, nearest first, as team-rules.ts mayAnswer reads it. */
export const chainAgentIds = (chain: readonly Superior[]): string[] =>
  chain.flatMap((level) => (level.kind === "agent" ? [level.agent.id] : []));

import { agents, db, projects, tasks } from "@abotica/db";
import type { ToolSet } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { allowsModelChain, projectsClosedTo, runProviderPolicy } from "../../models/provider-policy";
import type { Task } from "../../tasks/tasks";
import type { RunContext } from "../context";
import { modelChain } from "../model-chain";

export type ToolFactory = (ctx: RunContext) => ToolSet[string];

/** Models often send "", "null" or "<nil>" for absent optional values; treat those as missing. */
const EMPTY = new Set(["", "null", "<nil>", "nil", "none", "undefined", "n/a"]);
export const blankToUndefined = (v: unknown) =>
  typeof v === "string" && EMPTY.has(v.trim().toLowerCase()) ? undefined : v;

export const optionalId = () => z.preprocess(blankToUndefined, z.string().uuid().optional());
export const optionalText = () => z.preprocess(blankToUndefined, z.string().optional());

/** Accepts full ISO datetimes and plain dates (YYYY-MM-DD, read as end of day UTC). */
export const optionalDateTime = () =>
  z.preprocess(
    (v) => {
      const value = blankToUndefined(v);
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:00Z` : value;
    },
    z.string().datetime({ offset: true }).optional(),
  );

export const actorOf = (ctx: RunContext) => `agent:${ctx.agent.slug}`;

/** Expected failures go back to the model as data, so it can correct itself. */
export const errorResult = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });

/** Cuts long text and says how much is left, so the model knows it saw only part of it. */
export function clip(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}\n...[${text.length - max} more characters]` : text;
}

/**
 * Projects a run reaches besides its own tasks: the run's project only, or outside projects the ones
 * the agent manages. An agent on several projects never sees another one from inside a project.
 */
const scopedProjectIds = (ctx: RunContext): string[] => (ctx.projectId ? [ctx.projectId] : ctx.managedProjectIds);

/** Orchestrators see every project (undefined: no filter); other agents their scoped projects. */
export const visibleProjects = (ctx: RunContext) => (ctx.agent.kind === "orchestrator" ? undefined : scopedProjectIds(ctx));

async function allProjectIds(): Promise<string[]> {
  return (await db.select({ id: projects.id }).from(projects)).map((p) => p.id);
}

export async function readableProjectIds(ctx: RunContext): Promise<string[]> {
  return ctx.agent.kind === "orchestrator" ? allProjectIds() : scopedProjectIds(ctx);
}

/**
 * Projects whose stored content must not reach this run's models: their restriction does not allow
 * every model of its chain. Tools return their metadata only (see withholdClosed).
 */
export async function closedProjects(ctx: RunContext): Promise<ReadonlySet<string>> {
  return projectsClosedTo(await modelChain(ctx));
}

/**
 * Whether another run's stored content must not reach this run's models. Stricter than its project
 * alone: a run outside projects may hold the results its conversation received from restricted ones.
 */
export async function runContentClosed(
  ctx: RunContext,
  run: { projectId: string | null; conversationId: string | null },
): Promise<boolean> {
  const [policy, chain] = await Promise.all([runProviderPolicy(run.projectId, run.conversationId), modelChain(ctx)]);
  return !allowsModelChain(policy, chain);
}

export async function agentBySlug(slug: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.slug, slug));
  return agent;
}

/**
 * Orchestrators reach every task; other agents the tasks of their scoped projects and their own,
 * except, inside a project, their own tasks of other projects.
 */
function canSeeTask(ctx: RunContext, task: Task): boolean {
  if (ctx.agent.kind === "orchestrator") return true;
  if (task.projectId !== null && scopedProjectIds(ctx).includes(task.projectId)) return true;
  return task.assigneeAgentId === ctx.agent.id && (task.projectId === null || !ctx.projectId);
}

/** The task when this agent may see it, otherwise an error for the model. */
export async function visibleTask(ctx: RunContext, taskId: string): Promise<Task | { error: string }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || !canSeeTask(ctx, task))
    return { error: `Task ${taskId} does not exist or is not visible to you. Use task_list.` };
  return task;
}

export const taskSummary = (t: Task) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  projectId: t.projectId,
  assigneeAgentId: t.assigneeAgentId,
  deadline: t.deadline?.toISOString() ?? null,
  // A subtask names its parent, so a task_list that shows both does not read as two unrelated pieces of work.
  ...(t.parentId ? { parentId: t.parentId } : {}),
  // Delegated while too many of its round ran: it starts on its own, nobody needs to start it.
  ...(t.waitingForSlotSince ? { waitingForFreePlace: true } : {}),
});

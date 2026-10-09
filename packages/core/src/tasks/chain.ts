/**
 * The chain of command above a task: who gave it (the agent whose run delegated it, in that run's
 * conversation) and on up to the user. Questions, deadlines, quiet tasks, dependency alerts and
 * failures all go up this way. Work a schedule or trigger fired goes to the agent above its assignee
 * (automation-target.ts), and from the super agent to the user.
 */
import type { agents } from "@abotica/db";
import type { RunTrigger } from "../runs/runs";

type Agent = typeof agents.$inferSelect;

/**
 * The level above a task: an agent, with the conversation and run that delegated it and the agent's own
 * task (null outside one), or the user, with the conversation that reaches them (null: notifications only).
 */
export type Superior =
  | { kind: "agent"; agent: Agent; conversationId: string; taskId: string | null; runId: string; trigger: RunTrigger }
  | { kind: "user"; conversationId: string | null };

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/** Whoever gave the task: its delegator, or the user when no agent stands above it. */
export async function superiorOf(taskId: string): Promise<Superior> {
  throw notImplemented("superiorOf", taskId);
}

/**
 * The levels above the task, nearest first, up to `max` of them; the walk ends at the user, who is always
 * the last level when it is reached.
 */
export async function chainOfCommand(taskId: string, max = 4): Promise<Superior[]> {
  throw notImplemented("chainOfCommand", taskId, max);
}

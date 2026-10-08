/**
 * Who work fired by a schedule or trigger answers to. A schedule of a manager or a specialist is work the
 * hierarchy gave them, so it runs as a task (tasks.reportsUp) and its result goes up like a delegated
 * task's: a specialist's to the project's manager, a manager's (and a specialist's without one) to the
 * super agent, who tells the user. A result that needs nobody's attention ends at the agent that did it
 * (nothingNew). Pure, so the rules are testable on their own.
 */
import type { AgentKind } from "@abotica/db";

/** The agent above the assignee: "manager" is the project's manager, "orchestrator" the super agent. */
export type ReportTarget = "manager" | "orchestrator";

export function reportTargetOf(
  assignee: { id: string; kind: AgentKind },
  manager: { id: string; enabled: boolean } | null,
): ReportTarget | null {
  if (assignee.kind === "orchestrator") return null;
  if (assignee.kind === "specialist" && manager?.enabled && manager.id !== assignee.id) return "manager";
  return "orchestrator";
}

type QuietCandidate = {
  reportsUp: boolean;
  delegatedByRunId: string | null;
  assigneeAgentId: string | null;
  status: string;
};

/**
 * Why the agent may not end the task with nothingNew, or null when it may: only the assignee of work a
 * schedule or trigger fired, while it is still working on it. Once someone sent it back with a fix to
 * make, that one waits for the answer.
 */
export function nothingNewRefusal(task: QuietCandidate, agentId: string): string | null {
  if (!task.reportsUp) return "nothingNew is only for work a schedule or trigger started: set status 'review' instead.";
  if (task.delegatedByRunId) {
    return "This task was sent back to you with something to fix: set status 'review' so the agent that sent it gets the answer.";
  }
  if (task.assigneeAgentId !== agentId) return "Only the agent the task is assigned to can end it with nothingNew.";
  if (task.status !== "in_progress")
    return `The task is ${task.status}, not in progress: nothingNew ends work while it runs.`;
  return null;
}

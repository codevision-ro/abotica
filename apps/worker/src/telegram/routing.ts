/**
 * Pure rules for what reaches Telegram: the super agent, and the platform's notices about the user's own
 * tasks. No server imports, so they are testable on their own.
 */
import type { AgentKind, runs, tasks } from "@abotica/db";

/** The task a run worked on, as the notice rules need it. */
type NoticeTask = Pick<typeof tasks.$inferSelect, "status" | "createdBy" | "delegatedByRunId" | "reportsUp">;

/**
 * The Telegram notice a finished run sends, if any. The super agent's own runs (its schedules, webhooks,
 * tasks) tell the user. A manager or a specialist tells the user only about a task the user gave it
 * directly, once it needs them: ready for review, blocked, or failed; a run that leaves the task in
 * progress (it waits for delegated work or a wakeup) says nothing. Everything else they do reports up
 * the hierarchy, and the super agent tells the user. Successful chat runs already answered in their chat.
 */
export function runFinishedNotice(
  run: Pick<typeof runs.$inferSelect, "trigger" | "status">,
  kind: AgentKind | null | undefined,
  task: NoticeTask | null = null,
): "failed" | "succeeded" | "blocked" | null {
  if (!kind || run.trigger === "system") return null;
  if (kind === "orchestrator") {
    if (run.status === "failed") return "failed";
    if (run.status === "succeeded" && run.trigger !== "chat" && run.trigger !== "telegram") return "succeeded";
    return null;
  }
  const fromUser = task && task.createdBy === "user" && !task.delegatedByRunId && !task.reportsUp;
  if (!fromUser) return null;
  if (run.status === "failed") return "failed";
  if (run.status !== "succeeded") return null;
  if (task.status === "review" || task.status === "done") return "succeeded";
  if (task.status === "blocked") return "blocked";
  return null;
}

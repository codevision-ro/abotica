/**
 * Pure rules for who talks on Telegram: only the super agent. No server imports, so they are testable
 * on their own.
 */
import type { AgentKind, runs } from "@abotica/db";

/**
 * The conversation key of a chat: one conversation per chat, and per forum topic or reply thread.
 * Project topics are no exception: the super agent answers there too.
 */
export function externalIdOf(chatId: number, threadId: number | undefined): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

/**
 * The Telegram notice a finished run sends, if any. Only the super agent's own runs (its schedules,
 * webhooks, tasks) tell the user: managers and specialists report up the hierarchy instead, and the
 * super agent tells the user. Successful chat runs already answered in their chat.
 */
export function runFinishedNotice(
  run: Pick<typeof runs.$inferSelect, "trigger" | "status">,
  kind: AgentKind | null | undefined,
): "failed" | "succeeded" | null {
  if (kind !== "orchestrator" || run.trigger === "system") return null;
  if (run.status === "failed") return "failed";
  if (run.status === "succeeded" && run.trigger !== "chat" && run.trigger !== "telegram") return "succeeded";
  return null;
}

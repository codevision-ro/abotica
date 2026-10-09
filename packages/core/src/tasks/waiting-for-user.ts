/**
 * Everything that waits for the user, in one list: pending approvals, questions that reached them, tasks
 * assigned to them, and blocked tasks with no agent above them. Reminders bring it up again every
 * reminderHours (Settings, reports).
 */

/** One thing waiting for the user, with what it is about and since when. */
export type WaitingItem = {
  kind: "approval" | "question" | "task" | "blocked";
  /** The approval's, the question's (task comment) or the task's id, by kind. */
  id: string;
  title: string;
  taskId: string | null;
  projectId: string | null;
  since: Date;
};

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/** What waits for the user now, oldest first. */
export async function listWaitingForUser(): Promise<WaitingItem[]> {
  throw notImplemented("listWaitingForUser");
}

/**
 * Sends one notification listing what has waited longer than reminderHours and was not brought up within
 * them, then marks those reminded. Returns how many items it listed.
 */
export async function sendWaitingReminders(now: Date = new Date()): Promise<number> {
  throw notImplemented("sendWaitingReminders", now);
}

/**
 * Notices the platform puts into an agent's conversation about a task: an instruction, a question or its
 * answer, progress, a pause or cancel, a reminder or alert, a colleague's help. Each is a user-role
 * message whose metadata says it is not the user writing. Pure and client-safe: the web chat renders
 * them as cards.
 */
import { isDelegationReport } from "./delegation-report";

export type TaskNoticeKind =
  "instruction" | "question" | "answer" | "progress" | "control" | "reminder" | "alert" | "help-answer";

export type TaskNoticeMetadata = {
  kind: "task-notice";
  notice: TaskNoticeKind;
  /** The task the notice is about. */
  taskId: string;
  taskTitle: string;
  projectId: string | null;
  /** Who it comes from, as people read it: an agent's name, the user, or Abotica. */
  from: string;
  /** The task comment it carries, if any. */
  commentId?: string;
  /** The question it asks or answers. */
  questionId?: string;
  /** About urgent work, or it needs attention now. */
  urgent?: boolean;
};

export const isTaskNotice = (metadata: unknown): metadata is TaskNoticeMetadata =>
  typeof metadata === "object" && metadata !== null && (metadata as { kind?: unknown }).kind === "task-notice";

/**
 * A message the platform wrote (a delegation report or a task notice), not the user: it never counts as
 * the user writing, for a retry or a held reply.
 */
export const isPlatformNotice = (metadata: unknown): boolean => isDelegationReport(metadata) || isTaskNotice(metadata);

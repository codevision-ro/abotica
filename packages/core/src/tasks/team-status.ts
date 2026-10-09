/**
 * A snapshot of the open work in projects (team_status): who does what, how far it is and what each task
 * waits for. The super agent sees every project, a manager the ones it leads; content of projects closed
 * to the reader's models is withheld by the tool.
 */
import type { TaskPriority, TaskStatus } from "./tasks";

/** What keeps a task from moving now. */
export type TaskWaitingFor =
  | { kind: "dependencies"; taskIds: string[] }
  | { kind: "slot" }
  | { kind: "answer"; questionIds: string[] }
  | { kind: "wakeup" }
  | { kind: "paused"; forTaskId: string | null }
  | { kind: "retry"; at: Date }
  | { kind: "continuation"; done: number; of: number };

export type TeamStatusTask = {
  id: string;
  title: string;
  projectId: string | null;
  /** The assignee's slug; null for the user or nobody. */
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: Date | null;
  /** Minutes past the deadline; null when it has none or is not late. */
  lateByMinutes: number | null;
  activeRun: { id: string; steps: number; startedAt: Date | null } | null;
  lastProgress: { text: string; at: Date } | null;
  /** Open questions about the task: to whom (a slug, or "user") and since when. */
  openQuestions: { id: string; to: string; since: Date }[];
  waitingFor: TaskWaitingFor[];
  /** Subtasks whose result has not come back yet. */
  unreportedSubtasks: number;
};

function notImplemented(name: string, ...args: unknown[]): Error {
  return new Error(`${name} is not implemented yet`, { cause: args });
}

/** The open tasks (done and cancelled ones too with `includeDone`) of the projects, or of every project. */
export async function teamStatus(
  scope: { projectIds?: string[] },
  opts: { includeDone?: boolean } = {},
): Promise<TeamStatusTask[]> {
  throw notImplemented("teamStatus", scope, opts);
}

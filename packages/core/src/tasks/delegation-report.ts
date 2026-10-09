import type { tasks } from "@abotica/db";

/** A file a reported task produced; the report message also carries it as a file part. */
type DelegationReportFile = { id: string; name: string; mimeType: string; size: number };

/** The notice a delegation report adds to a conversation. Pure and client-safe: the web chat renders it. */
export type DelegationReportMetadata = {
  kind: "delegation-report";
  /**
   * `agent` is the agent's display name. `files` is missing in reports made before files existed,
   * `projectId` in reports made before provider restrictions covered them.
   */
  tasks: {
    id: string;
    title: string;
    agent: string | null;
    status: TaskStatus;
    projectId?: string | null;
    files?: DelegationReportFile[];
  }[];
  /**
   * The tasks' projects allow none of the delegating agent's providers: the report went to the user,
   * who decides on the tasks, and is left out of the agent's model input.
   */
  withheld?: true;
};

type TaskStatus = (typeof tasks.$inferSelect)["status"];

/** Statuses a task is left in once its run is over, or once it was cancelled. */
export const SETTLED_TASK_STATUSES: readonly TaskStatus[] = ["review", "done", "blocked", "cancelled"];

/**
 * A run that delegated work while on a task of its own continues that task when the report arrives.
 * When the report is withheld from it, that task would wait forever unless it has settled already.
 */
export const ownTaskWaitsForReport = (ownTask: { status: TaskStatus } | null): boolean =>
  ownTask !== null && !SETTLED_TASK_STATUSES.includes(ownTask.status);

export const isDelegationReport = (metadata: unknown): metadata is DelegationReportMetadata =>
  typeof metadata === "object" && metadata !== null && (metadata as { kind?: unknown }).kind === "delegation-report";

export const isWithheldReport = (metadata: unknown): boolean => isDelegationReport(metadata) && metadata.withheld === true;

/**
 * The projects whose results a conversation's agent was given, from its messages' metadata: every
 * delegation report except the withheld ones. Tasks of reports that do not record their project are
 * returned for a lookup.
 */
export function reportedProjects(metadata: unknown[]): { projectIds: string[]; unresolvedTaskIds: string[] } {
  const projectIds = new Set<string>();
  const unresolvedTaskIds = new Set<string>();
  for (const report of metadata) {
    if (!isDelegationReport(report) || report.withheld) continue;
    for (const task of report.tasks) {
      if (task.projectId === undefined) unresolvedTaskIds.add(task.id);
      else if (task.projectId) projectIds.add(task.projectId);
    }
  }
  return { projectIds: [...projectIds], unresolvedTaskIds: [...unresolvedTaskIds] };
}

import type { mcpServers } from "@abotica/db";
import { Queue, QueueEvents } from "bullmq";
import { createRedis } from "./redis";

export const QUEUE = {
  runs: "agent-runs",
  schedules: "schedules",
  maintenance: "maintenance",
  notifications: "notifications",
  taskEvents: "task-events",
  delegationReports: "delegation-reports",
  sandbox: "sandbox",
} as const;

type McpServer = typeof mcpServers.$inferSelect;

export type RunJob = { runId: string };

export type ScheduleJob = { scheduleId: string };

export type MaintenanceJob =
  | { kind: "journals" }
  | { kind: "digest"; period: "daily" | "weekly" }
  | { kind: "consolidate" }
  | { kind: "catalog" }
  /** Recreates the sandbox backend from the settings and stores its status. */
  | { kind: "sandbox-check" }
  | { kind: "sandbox-remove"; key: string }
  /** Stops idle containers and removes workspaces whose owner is gone or that went unused too long. */
  | { kind: "sandbox-reap" }
  /** Removes unclaimed uploads and file bytes whose row is gone. */
  | { kind: "files-sweep" }
  /** Removes expired previews and copies whose preview is gone. */
  | { kind: "previews-sweep" }
  /** Fails runs nothing is going to end any more (see recoverRuns). */
  | { kind: "runs-reap" }
  /** Polls the open pull requests of tasks and reacts to CI, reviews and merges (tasks/pull-requests.ts). */
  | { kind: "prs-sync" }
  /** Looks for a newer Abotica release and tells the user once per version (platform/updates.ts). */
  | { kind: "updates-check" };

/** A task was created or finished; the worker fires its triggers and starts unblocked dependents. */
export type TaskEventJob = { taskId: string; event: "created" | "done" };

/** A run ended: the tasks delegated with its task are reported back to the delegator once all settled. */
export type DelegationReportJob = { runId: string };

/** Connects to a stdio MCP server in the worker and lists its tools (the registry "Test" action). */
export type SandboxJob = { kind: "mcp-test"; server: McpServer; timeoutMs?: number };

export type NotificationJob =
  | { kind: "text"; text: string; projectId?: string | null }
  | { kind: "approval"; approvalId: string }
  | { kind: "run-finished"; runId: string }
  /** A notice for the user in the conversation's own chat (nothing to send for a web conversation). */
  | { kind: "conversation-notice"; conversationId: string; text: string };

const globalForQueues = globalThis as unknown as {
  aboticaQueues?: Map<string, Queue>;
  aboticaSandboxEvents?: Promise<QueueEvents>;
};

function queue<T>(name: string): Queue<T> {
  globalForQueues.aboticaQueues ??= new Map();
  let q = globalForQueues.aboticaQueues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
    globalForQueues.aboticaQueues.set(name, q);
  }
  return q as Queue<T>;
}

const runsQueue = () => queue<RunJob>(QUEUE.runs);
export const schedulesQueue = () => queue<ScheduleJob>(QUEUE.schedules);
export const maintenanceQueue = () => queue<MaintenanceJob>(QUEUE.maintenance);
/** Work only the worker can do because it owns the sandbox; callers wait for the result. */
export const sandboxQueue = () => queue<SandboxJob>(QUEUE.sandbox);
/** Completion events of the sandbox queue, for callers that wait for a job's result. */
export function sandboxQueueEvents(): Promise<QueueEvents> {
  globalForQueues.aboticaSandboxEvents ??= (async () => {
    const events = new QueueEvents(QUEUE.sandbox, { connection: createRedis() });
    await events.waitUntilReady();
    return events;
  })().catch((error: unknown) => {
    globalForQueues.aboticaSandboxEvents = undefined;
    throw error;
  });
  return globalForQueues.aboticaSandboxEvents;
}
const notificationsQueue = () => queue<NotificationJob>(QUEUE.notifications);
const taskEventsQueue = () => queue<TaskEventJob>(QUEUE.taskEvents);
const delegationReportsQueue = () => queue<DelegationReportJob>(QUEUE.delegationReports);

export async function enqueueRun(runId: string): Promise<void> {
  // Retries are handled inside the runner (provider fallback), so a failed run is not replayed blindly.
  await runsQueue().add("run", { runId }, { jobId: runId, attempts: 1 });
}

export type RunJobState = Awaited<ReturnType<Queue["getJobState"]>>;

/** State of a run's job, whose id is the run id; "unknown" once the job is gone. */
export function runJobState(runId: string): Promise<RunJobState> {
  return runsQueue().getJobState(runId);
}

export async function notify(job: NotificationJob): Promise<void> {
  await notificationsQueue().add(job.kind, job);
}

/** Goes through the queue so tasks changed anywhere (web, worker, agents) fire their triggers. */
export async function enqueueTaskEvent(job: TaskEventJob): Promise<void> {
  // A retry could start the same triggered runs twice.
  await taskEventsQueue().add(job.event, job, { attempts: 1 });
}

/**
 * Reports a run's delegated task through the queue: the report survives a failed delivery (retried with
 * backoff, the claim is released in between) and the run lifecycle does not depend on delegation.
 */
export async function enqueueDelegationReport(runId: string): Promise<void> {
  // One pending report per run; removed once done, so the reaper can queue a missed one again.
  // BullMQ refuses custom ids with ":" (reserved for its repeatable jobs), hence the hyphen.
  await delegationReportsQueue().add(
    "report",
    { runId },
    { jobId: `report-${runId}`, attempts: 5, removeOnComplete: true, removeOnFail: true },
  );
}

import { db, schedules } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { isValidCron, normalizeCron } from "./cron";
import { type ScheduleJob, schedulesQueue } from "../infra/queues";
import { redis } from "../infra/redis";
import type { Run } from "../runs/runs";
import { startAutomationWork } from "./automation-work";
import type { Delegator } from "../tasks/team-rules";
import { AgentNotOnTeamError, assertAutomationAgent, assertWorksIn } from "./triggers";

export type Schedule = typeof schedules.$inferSelect;
type ScheduleValues = typeof schedules.$inferInsert;
type Timing = Pick<Schedule, "kind" | "cron" | "runAt">;

const schedulerId = (id: string) => `schedule:${id}`;

/**
 * The job of a one-off schedule. Each time gets its own id: BullMQ keeps finished jobs for a while
 * and would ignore a new job with the same id.
 */
export const onceJobId = (s: Pick<Schedule, "id" | "kind" | "runAt">) =>
  s.kind === "once" && s.runAt ? `${schedulerId(s.id)}:${s.runAt.getTime()}` : null;

/**
 * The timing columns for the schedule's kind, with the cron normalized; throws when its value is missing
 * or invalid.
 */
export function scheduleTiming(values: Pick<ScheduleValues, "kind" | "cron" | "runAt">): Timing {
  if (values.kind === "cron") {
    if (!values.cron || !isValidCron(values.cron)) throw new UserError("automations.validation.invalidCron");
    return { kind: "cron", cron: normalizeCron(values.cron), runAt: null };
  }
  if (!values.runAt) throw new UserError("automations.validation.chooseDateTime");
  return { kind: "once", cron: null, runAt: values.runAt };
}

/** Whether a fired job is the schedule's current one: an edit or a pause can leave an older job behind. */
export function isCurrentScheduleJob(
  schedule: Pick<Schedule, "id" | "kind" | "runAt" | "enabled">,
  job: { id?: string; repeatJobKey?: string },
): boolean {
  if (!schedule.enabled) return false;
  if (schedule.kind === "cron") return job.repeatJobKey === schedulerId(schedule.id);
  return job.id !== undefined && job.id === onceJobId(schedule);
}

/** Mirrors a schedule row into a BullMQ job scheduler or delayed job, removing what `previous` queued. */
async function syncSchedule(schedule: Schedule, previous?: Schedule): Promise<void> {
  const queue = schedulesQueue();
  const id = schedulerId(schedule.id);
  await queue.removeJobScheduler(id);
  const once = schedule.enabled ? onceJobId(schedule) : null;
  const stale = previous ? onceJobId(previous) : null;
  if (stale && stale !== once) await queue.remove(stale);
  if (!schedule.enabled) return;
  if (schedule.kind === "cron" && schedule.cron) {
    await queue.upsertJobScheduler(
      id,
      { pattern: schedule.cron, tz: schedule.timezone },
      { name: "schedule", data: { scheduleId: schedule.id } },
    );
  } else if (once && schedule.runAt) {
    const delay = Math.max(0, schedule.runAt.getTime() - Date.now());
    await queue.add("schedule", { scheduleId: schedule.id }, { jobId: once, delay });
  }
}

/** `by`: the agent creating it, held to the delegation rules (see assertAutomationAgent). */
export async function createSchedule(input: ScheduleValues, opts: { by?: Delegator } = {}): Promise<Schedule> {
  const values = { ...input, ...scheduleTiming(input) };
  await assertAutomationAgent(values.agentId, values.projectId ?? null, opts.by);
  const [row] = await db.insert(schedules).values(values).returning();
  await syncSchedule(row!);
  return row!;
}

export async function updateSchedule(
  id: string,
  patch: Partial<ScheduleValues>,
  opts: { by?: Delegator } = {},
): Promise<Schedule> {
  const [current] = await db.select().from(schedules).where(eq(schedules.id, id));
  if (!current) throw new UserError("automations.errors.scheduleNotFound");
  const next = { ...current, ...patch };
  // Pausing or rewording keeps who runs where, so it needs no new check (an agent may pause what it did not set up).
  if (next.agentId !== current.agentId || (next.projectId ?? null) !== current.projectId) {
    await assertAutomationAgent(next.agentId, next.projectId ?? null, opts.by);
  }
  const [row] = await db
    .update(schedules)
    .set({ ...patch, ...scheduleTiming(next) })
    .where(eq(schedules.id, id))
    .returning();
  if (!row) throw new UserError("automations.errors.scheduleNotFound");
  await syncSchedule(row, current);
  return row;
}

export async function deleteSchedule(id: string): Promise<void> {
  const [row] = await db.delete(schedules).where(eq(schedules.id, id)).returning();
  await schedulesQueue().removeJobScheduler(schedulerId(id));
  const once = row && onceJobId(row);
  if (once) await schedulesQueue().remove(once);
}

const startedKey = (jobId: string) => `abotica:schedule-job:${jobId}:started`;
const STARTED_TTL_SECONDS = 7 * 24 * 3600;

/** Starts the schedule's work (startAutomationWork); null when a repeating one skipped the fire. */
function startScheduleWork(schedule: Schedule, manual: boolean): Promise<Run | null> {
  return startAutomationWork({
    agentId: schedule.agentId,
    projectId: schedule.projectId,
    title: schedule.name,
    trigger: "schedule",
    runInput: schedule.prompt,
    description: schedule.prompt,
    scheduleId: schedule.id,
    repeats: schedule.kind === "cron",
    manual,
  });
}

/**
 * The user's "Run now": the same work a timed fire starts. Refused while the schedule's previous task
 * is still being worked on, and when its agent may not work in its project.
 */
export async function runScheduleNow(id: string): Promise<Run> {
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id));
  if (!schedule) throw new UserError("automations.errors.scheduleNotFound");
  await assertWorksIn(schedule.agentId, schedule.projectId);
  const run = await startScheduleWork(schedule, true);
  // A manual start is refused, never skipped, so there is always a run here.
  if (!run) throw new Error(`Schedule ${id} started nothing`);
  return run;
}

/**
 * Runs a fired schedule job. A failed job is retried; the first attempt to start the run claims the
 * job, so a retry after the run started (e.g. the lastRunAt update failed) does not start another.
 */
export async function fireSchedule(job: { id?: string; repeatJobKey?: string; data: ScheduleJob }): Promise<void> {
  const [schedule] = await db.select().from(schedules).where(eq(schedules.id, job.data.scheduleId));
  if (!schedule || !isCurrentScheduleJob(schedule, job)) return;
  try {
    await assertWorksIn(schedule.agentId, schedule.projectId);
  } catch (error) {
    if (!(error instanceof AgentNotOnTeamError)) throw error;
    // Not retried: nothing changes until the team does.
    console.warn(`[schedules] schedule ${schedule.id} skipped: its agent is not on the project's team`);
    return;
  }
  const key = job.id ? startedKey(job.id) : null;
  let started = true;
  if (!key || (await redis().set(key, "1", "EX", STARTED_TTL_SECONDS, "NX")) === "OK") {
    try {
      started = (await startScheduleWork(schedule, false)) !== null;
    } catch (error) {
      if (key) await redis().del(key);
      throw error;
    }
  }
  // A skipped fire ran nothing: the last run stays the one before it.
  await db
    .update(schedules)
    .set({ ...(started ? { lastRunAt: new Date() } : {}), ...(schedule.kind === "once" ? { enabled: false } : {}) })
    .where(eq(schedules.id, schedule.id));
}

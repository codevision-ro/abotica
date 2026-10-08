import { agents, db, tasks } from "@abotica/db";
import { and, eq, inArray } from "@abotica/db/orm";
import { getTranslator, UserError } from "@abotica/i18n";
import { getSettings, settingsLocale } from "../platform/settings";
import { type Run, startRun, startTaskRun } from "../runs/runs";
import { reportTargetAgent } from "../tasks/automation-target";
import { addTaskComment, createTask, deleteTask } from "../tasks/tasks";

/** Statuses of a fired task still being worked on: a schedule does not fire again on top of it. */
const WORKING = ["backlog", "in_progress"] as const;

export type AutomationWork = {
  agentId: string;
  projectId: string | null;
  title: string;
  trigger: "schedule" | "webhook" | "event";
  /** What the super agent's run gets as its message. */
  runInput: string;
  /** What a task gets as its description; outside data goes in `data`, so the description stays the user's text. */
  description: string;
  /** Outside data (a webhook's payload), already wrapped as untrusted: a system comment of the task. */
  data?: string;
  scheduleId?: string;
  triggerId?: string;
  /** A repeating schedule: a fire is skipped while the task of the previous one is still being worked on. */
  repeats?: boolean;
  /** Started by the user ("Run now"): refused while the schedule's previous task is still being worked on. */
  manual?: boolean;
};

/**
 * Starts what a schedule or trigger fired. The super agent runs it directly and tells the user. A
 * manager or a specialist gets it as a task that reports up the hierarchy on its own (tasks.reportsUp,
 * tasks/automation-rules.ts), so nothing they do reaches the user except through the super agent. A
 * schedule whose previous task still works does not fire on top of it. Null when nothing started.
 */
export async function startAutomationWork(work: AutomationWork): Promise<Run | null> {
  const [agent] = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, work.agentId));
  if (!agent) throw new UserError("automations.errors.agentNotFound");
  if (agent.kind === "orchestrator") {
    return startRun({
      agentId: work.agentId,
      trigger: work.trigger,
      input: work.runInput,
      projectId: work.projectId,
      title: work.title,
    });
  }

  if (work.scheduleId && (work.repeats || work.manual)) {
    const [working] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.scheduleId, work.scheduleId), inArray(tasks.status, [...WORKING])))
      .limit(1);
    if (working) {
      if (work.manual) throw new UserError("automations.errors.previousStillWorking");
      console.warn(`[automations] schedule ${work.scheduleId} skipped: its task ${working.id} is still being worked on`);
      return null;
    }
  }

  const task = await createTask(
    {
      title: work.title,
      description: work.description,
      projectId: work.projectId,
      assigneeAgentId: work.agentId,
      automation: { scheduleId: work.scheduleId ?? null, triggerId: work.triggerId ?? null },
    },
    "system",
  );
  try {
    const t = getTranslator(settingsLocale(await getSettings()));
    const above = await reportTargetAgent(task);
    await addTaskComment(
      task.id,
      t(work.scheduleId ? "tasks.automation.fromSchedule" : "tasks.automation.fromTrigger", {
        agent: above?.agent.name ?? t("tasks.automation.nobody"),
      }),
      "system",
    );
    if (work.data) await addTaskComment(task.id, work.data, "system");
    return await startTaskRun(task.id, { trigger: work.trigger });
  } catch (error) {
    // Nothing ran yet: a retry of the fire makes the task again, so this one must not stay behind.
    await deleteTask(task.id).catch((cleanup: unknown) =>
      console.error(`[automations] removing task ${task.id} after a failed start failed:`, cleanup),
    );
    throw error;
  }
}

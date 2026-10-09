"use server";

import {
  addTaskDependency,
  attachTaskFiles,
  cancelTask as cancelTaskTree,
  cancelWakeup,
  createTask as insertTask,
  deleteFile,
  deleteTask as removeTask,
  getFile,
  pauseTask as pauseTaskRun,
  pendingDependencies,
  postInstruction,
  redirectTask as redirectTaskCourse,
  resumeTask as resumeTaskRun,
  startTaskRun as enqueueTaskRun,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskStatus,
  updateTask as patchTask,
} from "@abotica/core";
import { db, taskDependencies, tasks } from "@abotica/db";
import { and, eq } from "@abotica/db/orm";
import { getTranslator, isUserError, translateKey, UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";

const STATUS = z.enum(TASK_STATUSES);
/** What the board and the status select may ask for: paused and cancelled go through the task controls. */
const ANY_STATUS = z.enum([...TASK_STATUSES, "paused", "cancelled"]);
/** Why the user put the task aside or stopped it, when they gave no reason: read by its agents. */
const REASON = z.string().trim().max(2_000).optional();
const PRIORITY = z.enum(TASK_PRIORITIES);
/** "user" = assigned to the human, "none" = unassigned, otherwise an agent id. */
const ASSIGNEE = z.union([z.literal("user"), z.literal("none"), z.uuid()]);

function assigneeFields(assignee: z.infer<typeof ASSIGNEE>) {
  if (assignee === "user") return { assigneeAgentId: null, assignedToUser: true };
  if (assignee === "none") return { assigneeAgentId: null, assignedToUser: false };
  return { assigneeAgentId: assignee, assignedToUser: false };
}

/** The reason the task's agents read when the user stopped or paused it without giving one. */
const byYou = async () => getTranslator(await getLocale())("tasks.control.byYou");

function revalidateTask(id?: string) {
  revalidatePath("/tasks");
  if (id) revalidatePath(`/tasks/${id}`);
}

export const createTask = action(
  z.object({
    title: z.string().trim().min(1, "tasks.validation.titleRequired").max(300),
    description: z.string().max(50_000).optional(),
    projectId: z.uuid().nullish(),
    parentId: z.uuid().nullish(),
    status: STATUS.optional(),
    priority: PRIORITY.optional(),
    deadline: z.iso.datetime({ offset: true }).nullish(),
    assignee: ASSIGNEE.optional(),
    dependsOn: z.array(z.uuid()).optional(),
    startNow: z.boolean().optional(),
  }),
  async (input) => {
    let projectId = input.projectId ?? null;
    if (input.parentId && !projectId) {
      const [parent] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, input.parentId));
      projectId = parent?.projectId ?? null;
    }
    const task = await insertTask(
      {
        title: input.title,
        description: input.description,
        projectId,
        parentId: input.parentId ?? null,
        status: input.status,
        priority: input.priority,
        deadline: input.deadline ? new Date(input.deadline) : null,
        dependsOn: input.dependsOn,
        ...assigneeFields(input.assignee ?? "none"),
      },
      "user",
    );
    let runError: string | undefined;
    if (input.startNow && task.assigneeAgentId) {
      const t = getTranslator(await getLocale());
      // Created but not started: a backlog task with an agent starts on its own once its dependencies are done.
      const pending = await pendingDependencies(task.id);
      if (pending.length) {
        const titles = pending.map((p) => p.title).join(", ");
        runError =
          task.status === "backlog"
            ? t("tasks.new.startsAfterDependencies", { titles })
            : t("tasks.errors.pendingDependencies", { titles });
      } else {
        try {
          await enqueueTaskRun(task.id);
        } catch (error) {
          // Unexpected errors can carry internals: logged here, the user gets the generic message.
          if (isUserError(error)) runError = translateKey(t, error.key, error.values);
          else {
            console.error(error);
            runError = t("tasks.errors.runNotStarted");
          }
        }
      }
    }
    revalidateTask(input.parentId ?? undefined);
    return { id: task.id, runError };
  },
);

/**
 * The user moved the task to `status` by hand. Paused and cancelled stop its runs (and, cancelled, its
 * subtree), and a paused task taken back to in progress resumes in its conversation: those go through
 * the task controls. True when it did; the caller then sets nothing else.
 */
async function controlByStatus(id: string, status: TaskStatus): Promise<boolean> {
  if (status === "paused") {
    await pauseTaskRun(id, { by: "user", reason: await byYou() });
    return true;
  }
  if (status === "cancelled") {
    await cancelTaskTree(id, { by: "user", reason: await byYou(), cascade: true });
    return true;
  }
  if (status !== "in_progress") return false;
  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, id));
  if (task?.status !== "paused") return false;
  await resumeTaskRun(id, { by: "user" });
  return true;
}

export const updateTask = action(
  z.object({
    id: z.uuid(),
    title: z.string().trim().min(1, "tasks.validation.titleRequired").max(300).optional(),
    description: z.string().max(50_000).optional(),
    status: ANY_STATUS.optional(),
    priority: PRIORITY.optional(),
    deadline: z.iso.datetime({ offset: true }).nullable().optional(),
    assignee: ASSIGNEE.optional(),
    projectId: z.uuid().nullable().optional(),
    output: z.string().max(200_000).nullable().optional(),
  }),
  async ({ id, assignee, deadline, status, ...rest }) => {
    const patch: Parameters<typeof patchTask>[1] = { ...rest };
    if (status && !(await controlByStatus(id, status))) patch.status = status;
    if (deadline !== undefined) patch.deadline = deadline ? new Date(deadline) : null;
    if (assignee !== undefined) Object.assign(patch, assigneeFields(assignee));
    if (Object.keys(patch).length) await patchTask(id, patch, "user");
    revalidateTask(id);
  },
);

/** Drag and drop on the board: new column and/or new position (midpoint between neighbours). */
export const moveTask = action(
  z.object({ id: z.uuid(), status: ANY_STATUS, position: z.number().finite() }),
  async ({ id, status, position }) => {
    if (await controlByStatus(id, status)) await patchTask(id, { position }, "user");
    else await patchTask(id, { status, position }, "user");
    revalidatePath("/tasks");
  },
);

/** Puts the task aside: its running run stops at its next step, and it waits until resumed. */
export const pauseTask = action(z.object({ id: z.uuid(), reason: REASON }), async ({ id, reason }) => {
  await pauseTaskRun(id, { by: "user", reason: reason || (await byYou()) });
  revalidateTask(id);
});

/** Goes on with a paused or blocked task, in the conversation it worked in. */
export const resumeTask = action(z.object({ id: z.uuid(), note: REASON }), async ({ id, note }) => {
  const { run } = await resumeTaskRun(id, { by: "user", note: note || undefined });
  revalidateTask(id);
  return { runId: run?.id ?? null };
});

/** Stops the task for good, with its subtasks and the work delegated from it unless `cascade` is off. */
export const cancelTask = action(
  z.object({ id: z.uuid(), reason: REASON, cascade: z.boolean() }),
  async ({ id, reason, cascade }) => {
    const { cancelled } = await cancelTaskTree(id, { by: "user", reason: reason || (await byYou()), cascade });
    revalidateTask(id);
    return { count: cancelled.length };
  },
);

/** Changes the course of a task underway: new instructions, another agent, its priority or deadline. */
export const redirectTask = action(
  z.object({
    id: z.uuid(),
    instructions: z.string().trim().max(20_000).optional(),
    reassignTo: z.uuid().optional(),
    priority: PRIORITY.optional(),
    deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
  async ({ id, instructions, reassignTo, priority, deadline }) => {
    await redirectTaskCourse(id, {
      by: "user",
      instructions: instructions || undefined,
      reassignTo,
      priority,
      deadline: deadline === undefined ? undefined : deadline ? new Date(deadline) : null,
    });
    revalidateTask(id);
  },
);

export const deleteTask = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const task = await removeTask(id);
  if (!task) throw new UserError("tasks.errors.notFound");
  revalidatePath("/tasks");
});

/** The user's start goes past the task's circuit breaker: they decide whether to try again. */
export const startTaskRun = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const run = await enqueueTaskRun(id, { force: true });
  revalidateTask(id);
  return { runId: run.id };
});

/** Cancels what the task waits for, or removes a wait that stopped. */
export const cancelTaskWakeup = action(z.object({ taskId: z.uuid(), id: z.uuid() }), async ({ taskId, id }) => {
  await cancelWakeup(taskId, id);
  revalidateTask(taskId);
});

/**
 * The user's message on the task: an instruction for its agent, delivered at once (into its running run,
 * or waking it). Says what became of it: steered, woke the agent, or only stored.
 */
export const sendTaskMessage = action(
  z.object({ taskId: z.uuid(), body: z.string().trim().min(1, "tasks.validation.commentEmpty").max(20_000) }),
  async ({ taskId, body }) => {
    const posted = await postInstruction(taskId, body, "user");
    revalidateTask(taskId);
    return { delivered: posted.delivered, error: posted.error ?? null };
  },
);

export const createTaskDependency = action(
  z.object({ taskId: z.uuid(), dependsOnTaskId: z.uuid() }),
  async ({ taskId, dependsOnTaskId }) => {
    await addTaskDependency(taskId, dependsOnTaskId);
    revalidateTask(taskId);
  },
);

export const deleteTaskDependency = action(
  z.object({ taskId: z.uuid(), dependsOnTaskId: z.uuid() }),
  async ({ taskId, dependsOnTaskId }) => {
    await db
      .delete(taskDependencies)
      .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)));
    revalidateTask(taskId);
  },
);

/** Attaches files uploaded through POST /api/files to a task. */
export const createTaskFiles = action(
  z.object({ taskId: z.uuid(), fileIds: z.array(z.uuid()).min(1, "files.errors.noFiles") }),
  async ({ taskId, fileIds }) => {
    const files = await attachTaskFiles(taskId, fileIds);
    revalidateTask(taskId);
    return { count: files.length };
  },
);

export const deleteTaskFile = action(z.object({ taskId: z.uuid(), id: z.uuid() }), async ({ taskId, id }) => {
  const file = await getFile(id);
  if (file?.taskId !== taskId) throw new UserError("files.errors.notFound");
  await deleteFile(id);
  revalidateTask(taskId);
});

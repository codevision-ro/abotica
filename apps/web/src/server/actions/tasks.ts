"use server";

import {
  addTaskComment,
  addTaskDependency,
  attachTaskFiles,
  createTask as insertTask,
  deleteFile,
  deleteTask as removeTask,
  getFile,
  pendingDependencies,
  startTaskRun as enqueueTaskRun,
  TASK_PRIORITIES,
  TASK_STATUSES,
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
const PRIORITY = z.enum(TASK_PRIORITIES);
/** "user" = assigned to the human, "none" = unassigned, otherwise an agent id. */
const ASSIGNEE = z.union([z.literal("user"), z.literal("none"), z.uuid()]);

function assigneeFields(assignee: z.infer<typeof ASSIGNEE>) {
  if (assignee === "user") return { assigneeAgentId: null, assignedToUser: true };
  if (assignee === "none") return { assigneeAgentId: null, assignedToUser: false };
  return { assigneeAgentId: assignee, assignedToUser: false };
}

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

export const updateTask = action(
  z.object({
    id: z.uuid(),
    title: z.string().trim().min(1, "tasks.validation.titleRequired").max(300).optional(),
    description: z.string().max(50_000).optional(),
    status: STATUS.optional(),
    priority: PRIORITY.optional(),
    deadline: z.iso.datetime({ offset: true }).nullable().optional(),
    assignee: ASSIGNEE.optional(),
    projectId: z.uuid().nullable().optional(),
    output: z.string().max(200_000).nullable().optional(),
  }),
  async ({ id, assignee, deadline, ...rest }) => {
    const patch: Parameters<typeof patchTask>[1] = { ...rest };
    if (deadline !== undefined) patch.deadline = deadline ? new Date(deadline) : null;
    if (assignee !== undefined) Object.assign(patch, assigneeFields(assignee));
    await patchTask(id, patch, "user");
    revalidateTask(id);
  },
);

/** Drag and drop on the board: new column and/or new position (midpoint between neighbours). */
export const moveTask = action(
  z.object({ id: z.uuid(), status: STATUS, position: z.number().finite() }),
  async ({ id, status, position }) => {
    await patchTask(id, { status, position }, "user");
    revalidatePath("/tasks");
  },
);

export const deleteTask = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const task = await removeTask(id);
  if (!task) throw new UserError("tasks.errors.notFound");
  revalidatePath("/tasks");
});

export const startTaskRun = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const run = await enqueueTaskRun(id);
  revalidateTask(id);
  return { runId: run.id };
});

export const createTaskComment = action(
  z.object({ taskId: z.uuid(), body: z.string().trim().min(1, "tasks.validation.commentEmpty").max(20_000) }),
  async ({ taskId, body }) => {
    await addTaskComment(taskId, body, "user");
    revalidateTask(taskId);
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

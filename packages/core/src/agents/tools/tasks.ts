import { agents, db, runs, taskComments, taskDependencies, tasks } from "@abotica/db";
import { tool } from "ai";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "@abotica/db/orm";
import { z } from "zod";
import { audit } from "../../platform/audit";
import { fileUrl } from "../../files/file-types";
import { listFiles } from "../../files/files";
import {
  activeTaskRun,
  addTaskComment,
  createTask,
  deleteTask,
  TASK_PRIORITIES,
  TASK_STATUSES,
  updateTask,
} from "../../tasks/tasks";
import { inputPath } from "../workspace-paths";
import {
  actorOf,
  agentBySlug,
  clip,
  optionalDateTime,
  optionalId,
  optionalText,
  readableProjectIds,
  taskSummary,
  closedProjects,
  type ToolFactory,
  visibleProjects,
  visibleTask,
} from "./shared";
import { withholdClosed } from "./withheld";

const COMMENT_LIMIT = 30;

export const taskTools: Record<string, ToolFactory> = {
  task_list: (ctx) =>
    tool({
      description:
        "List tasks, optionally filtered by project, status or agent. Use task_get for a task's details and result.",
      inputSchema: z.object({
        projectId: optionalId(),
        status: z.enum(TASK_STATUSES).optional(),
        assigneeAgentSlug: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async ({ projectId, status, assigneeAgentSlug, search, limit }) => {
        const scope = visibleProjects(ctx);
        // Inside a project, the agent's own tasks of other projects stay out of sight.
        const own = ctx.projectId
          ? and(eq(tasks.assigneeAgentId, ctx.agent.id), isNull(tasks.projectId))
          : eq(tasks.assigneeAgentId, ctx.agent.id);
        const assignee = assigneeAgentSlug ? await agentBySlug(assigneeAgentSlug) : undefined;
        const rows = await db
          .select()
          .from(tasks)
          .where(
            and(
              projectId ? eq(tasks.projectId, projectId) : undefined,
              scope ? (scope.length ? or(inArray(tasks.projectId, scope), own) : own) : undefined,
              status ? eq(tasks.status, status) : undefined,
              assignee ? eq(tasks.assigneeAgentId, assignee.id) : undefined,
              search ? ilike(tasks.title, `%${search}%`) : undefined,
              isNull(tasks.parentId),
            ),
          )
          .orderBy(desc(tasks.updatedAt))
          .limit(limit);
        return rows.map(taskSummary);
      },
    }),

  task_get: (ctx) =>
    tool({
      description:
        "Read one task in full: description, output (the result), comments, subtasks, dependencies, attachments and its latest runs.",
      inputSchema: z.object({ taskId: z.string().uuid() }),
      execute: async ({ taskId }) => {
        const task = await visibleTask(ctx, taskId);
        if ("error" in task) return task;
        const [closed, assignee, comments, subtasks, dependsOn, attachments, latestRuns] = await Promise.all([
          closedProjects(ctx),
          task.assigneeAgentId
            ? db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, task.assigneeAgentId))
            : [],
          db
            .select({
              body: taskComments.body,
              kind: taskComments.authorKind,
              agent: agents.slug,
              createdAt: taskComments.createdAt,
            })
            .from(taskComments)
            .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
            .where(eq(taskComments.taskId, task.id))
            .orderBy(desc(taskComments.createdAt))
            .limit(COMMENT_LIMIT),
          db.select().from(tasks).where(eq(tasks.parentId, task.id)).orderBy(asc(tasks.createdAt)),
          db
            .select({ id: tasks.id, title: tasks.title, status: tasks.status })
            .from(taskDependencies)
            .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
            .where(eq(taskDependencies.taskId, task.id)),
          listFiles({ taskId: task.id }),
          db
            .select({
              id: runs.id,
              status: runs.status,
              error: runs.error,
              costUsd: runs.costUsd,
              createdAt: runs.createdAt,
            })
            .from(runs)
            .where(eq(runs.taskId, task.id))
            .orderBy(desc(runs.createdAt))
            .limit(5),
        ]);
        const details = {
          ...taskSummary(task),
          assignee: task.assignedToUser ? "user" : (assignee[0]?.slug ?? null),
          description: clip(task.description, 8_000),
          output: clip(task.output, 20_000),
          createdBy: task.createdBy,
          parentId: task.parentId,
          createdAt: task.createdAt.toISOString(),
          completedAt: task.completedAt?.toISOString() ?? null,
          // Oldest first, like a conversation; only the latest ones are kept.
          comments: comments.reverse().map((c) => ({
            author: c.kind === "agent" ? (c.agent ?? "agent") : c.kind,
            body: clip(c.body, 2_000),
            at: c.createdAt.toISOString(),
          })),
          subtasks: subtasks.map(taskSummary),
          dependsOn,
          // Files of the task: attached by the user, handed over by a delegating agent or produced by its
          // runs. workspacePath is where a run that has the file (the task's own, or one it was reported to) finds it.
          attachments: attachments.map((f) => ({
            name: f.name,
            mimeType: f.mimeType,
            size: f.size,
            source: f.source,
            url: fileUrl(f.id),
            workspacePath: inputPath(f),
          })),
          runs: latestRuns.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        };
        return withholdClosed(details, task.projectId, closed, ["description", "output", "comments", "runs"]);
      },
    }),

  task_create: (ctx) =>
    tool({
      description:
        "Create a task or subtask. To hand it to another agent and start it, the super agent and project managers use delegate_task.",
      inputSchema: z.object({
        title: z.string().min(3),
        description: z.string().default(""),
        projectId: optionalId(),
        parentId: optionalId(),
        priority: z.enum(TASK_PRIORITIES).default("medium"),
        deadline: optionalDateTime(),
        forUser: z.boolean().default(false).describe("True if the task is for the user, not for an agent"),
      }),
      execute: async (input) => {
        if (input.projectId && !(await readableProjectIds(ctx)).includes(input.projectId)) {
          return { error: `Project ${input.projectId} is not one of yours` };
        }
        let projectId = input.projectId ?? ctx.projectId;
        if (input.parentId) {
          const parent = await visibleTask(ctx, input.parentId);
          if ("error" in parent) return parent;
          // A subtask lives in its parent's project.
          if (input.projectId && input.projectId !== parent.projectId) {
            return {
              error: `A subtask belongs to its parent's project (${parent.projectId ?? "none"}): leave projectId out.`,
            };
          }
          projectId = parent.projectId;
        }
        const task = await createTask(
          {
            title: input.title,
            description: input.description,
            projectId,
            parentId: input.parentId,
            priority: input.priority,
            deadline: input.deadline ? new Date(input.deadline) : null,
            assignedToUser: input.forUser,
            assigneeAgentId: input.forUser ? null : ctx.agent.id,
          },
          actorOf(ctx),
        );
        return taskSummary(task);
      },
    }),

  task_update: (ctx) =>
    tool({
      description:
        "Update a task: status, output (the full result), priority, title, description or deadline. Only the fields you send change.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        status: z.enum(TASK_STATUSES).optional(),
        output: optionalText(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        title: optionalText(),
        description: optionalText(),
        deadline: optionalDateTime(),
      }),
      execute: async ({ taskId, status, output, priority, title, description, deadline }) => {
        const found = await visibleTask(ctx, taskId);
        if ("error" in found) return found;
        // Whoever delegated a task decides when it is done: the super agent, or the manager that handed it on.
        if (status === "done" && found.delegatedByRunId && !ctx.agent.isOrchestrator) {
          const [delegator] = await db
            .select({ agentId: runs.agentId })
            .from(runs)
            .where(eq(runs.id, found.delegatedByRunId));
          if (delegator?.agentId !== ctx.agent.id) {
            return {
              error:
                "This task was delegated to you: set status 'review'. The agent that delegated it decides whether it is done.",
            };
          }
        }
        if (title !== undefined && title.trim().length < 3) return { error: "The title needs at least 3 characters" };
        const task = await updateTask(
          taskId,
          {
            status,
            output,
            priority,
            title: title?.trim(),
            description,
            deadline: deadline ? new Date(deadline) : undefined,
          },
          actorOf(ctx),
        );
        return taskSummary(task);
      },
    }),

  task_delete: (ctx) =>
    tool({
      description:
        "Delete a task for good, with its subtasks, comments and attachments (requires the user's approval). Only for tasks created by mistake or duplicated; finished work is marked done, not deleted.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        taskTitle: z.string().describe("The task's exact title, shown to the user in the approval request"),
        reason: z.string().min(3),
      }),
      execute: async ({ taskId, taskTitle, reason }) => {
        const task = await visibleTask(ctx, taskId);
        if ("error" in task) return task;
        // The user approved what the title said; never delete a different task.
        if (task.title.trim().toLowerCase() !== taskTitle.trim().toLowerCase()) {
          return { error: `Task ${taskId} is titled "${task.title}", not "${taskTitle}". Nothing was deleted.` };
        }
        const active = await activeTaskRun(task.id);
        if (active) return { error: `Task ${task.id} has an active run (${active.id}). Stop it first with run_cancel.` };
        await deleteTask(task.id);
        await audit({
          actor: actorOf(ctx),
          action: "task.deleted",
          entityType: "task",
          entityId: task.id,
          data: { title: task.title, reason },
        });
        return { deleted: true, id: task.id, title: task.title };
      },
    }),

  task_comment: (ctx) =>
    tool({
      description: "Add a comment to a task (progress, questions, blockers).",
      inputSchema: z.object({ taskId: z.string().uuid(), body: z.string().min(1) }),
      execute: async ({ taskId, body }) => {
        const task = await visibleTask(ctx, taskId);
        if ("error" in task) return task;
        await addTaskComment(task.id, body, { agentId: ctx.agent.id });
        return { ok: true };
      },
    }),
};

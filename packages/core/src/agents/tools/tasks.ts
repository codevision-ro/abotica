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
import { listTaskPullRequests } from "../../tasks/pull-requests";
import { DEFAULT_MAX_FIRES, MAX_FIRES_LIMIT, WAKEUP_KINDS } from "../../tasks/wakeup-rules";
import { armWakeup, listTaskWakeups, type WakeupRequest } from "../../tasks/wakeups";
import { clipUntrusted, hasUntrusted } from "../untrusted";
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
        "Read one task in full: description, output (the result), comments, subtasks, dependencies, attachments, its pull requests (state, CI checks, review), what it waits for (task_wait) and its latest runs.",
      inputSchema: z.object({ taskId: z.string().uuid() }),
      execute: async ({ taskId }) => {
        const task = await visibleTask(ctx, taskId);
        if ("error" in task) return task;
        const [closed, assignee, comments, subtasks, dependsOn, attachments, latestRuns, pullRequests, wakeups] =
          await Promise.all([
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
            listTaskPullRequests(task.id),
            listTaskWakeups(task.id),
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
            // A system comment can carry outside text (CI logs, review comments): its block stays closed.
            body: hasUntrusted(c.body) ? clipUntrusted(c.body, 2_000) : clip(c.body, 2_000),
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
          // As of the last sync (every minute or so): checks none | pending | success | failure.
          pullRequests: pullRequests.map((p) => ({
            url: p.url,
            number: p.number,
            branch: p.headBranch,
            base: p.baseBranch,
            state: p.state,
            draft: p.draft,
            checks: p.checks,
            review: p.review,
          })),
          // Waiting (active), or stopped by a runaway limit (paused) or its expiry (expired).
          wakeups: wakeups.map((w) => ({
            id: w.id,
            kind: w.kind,
            status: w.status,
            pausedReason: w.pausedReason,
            pullRequest: w.pullRequest?.url ?? null,
            // task_status: the task it waits on and the status it waits for.
            watchedTask: w.watchedTask && { ...w.watchedTask, status: w.condition.status },
            everyMinutes: w.condition.everyMinutes ?? null,
            nextAt: w.nextCheckAt?.toISOString() ?? null,
            expiresAt: w.expiresAt?.toISOString() ?? null,
            fires: w.fires,
            maxFires: w.maxFires,
            notes: clip(w.notes, 2_000),
          })),
        };
        return withholdClosed(details, task.projectId, closed, ["description", "output", "comments", "runs", "wakeups"]);
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

  task_wait: (ctx) =>
    tool({
      description: [
        "End your run and be woken later on a task: at a time (timer), when the CI checks of its pull request finish (pr_checks_finished) or it is merged (pr_merged), when all its subtasks are done (subtasks_done), or when another task reaches a status (task_status).",
        "The task stays in progress meanwhile. When it happens you get a new run, with a comment saying what woke you and your notes; read the current state with your tools then.",
        "Asking again for the same condition replaces it, and a task has one timer. To check periodically, set one repeating wait (everyMinutes, or repeat) instead of a new one each run: a wait set again run after run without the user in between is paused as a loop, and the user is told.",
        "Checks already finished when you call it do not count. Call it last, then end your run.",
      ].join(" "),
      inputSchema: z.object({
        taskId: optionalId().describe("Defaults to this run's task; it must be assigned to you"),
        kind: z.enum(WAKEUP_KINDS),
        at: optionalDateTime().describe("timer: when"),
        afterMinutes: z.number().int().min(1).optional().describe("timer: in how many minutes, instead of at"),
        everyMinutes: z.number().int().min(1).optional().describe("timer: repeat every this many minutes"),
        pullRequestUrl: optionalText().describe(
          "pr_checks_finished, pr_merged: which pull request; default the task's latest",
        ),
        watchTaskId: optionalId().describe("task_status: the task to wait on"),
        status: z.enum(TASK_STATUSES).optional().describe("task_status: the status to wait for"),
        repeat: z
          .boolean()
          .default(false)
          .describe("pr_checks_finished, subtasks_done, task_status: wake again each time it happens again"),
        maxFires: z
          .number()
          .int()
          .min(2)
          .max(MAX_FIRES_LIMIT)
          .optional()
          .describe(`Repeating waits: how many times at most (default ${DEFAULT_MAX_FIRES})`),
        expiresInMinutes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Give up after this long: the task is then blocked for the user"),
        notes: z.string().max(2_000).default("").describe("What to do once woken; you get them back then"),
      }),
      execute: async (input) => {
        const taskId = input.taskId ?? ctx.run.taskId;
        if (!taskId) return { error: "This run has no task: pass taskId." };
        const task = await visibleTask(ctx, taskId);
        if ("error" in task) return task;
        if (task.assigneeAgentId !== ctx.agent.id) {
          return { error: "Only the task's assignee waits on it, and this task is not assigned to you." };
        }
        if (task.status === "done") return { error: "The task is done: there is nothing to wait for." };
        const target = await waitTarget(ctx, task.id, input);
        if ("error" in target) return target;
        const now = Date.now();
        const repeating = input.kind === "timer" ? Boolean(input.everyMinutes) : input.repeat;
        const wakeup = await armWakeup({
          ...target,
          taskId: task.id,
          agentId: ctx.agent.id,
          run: { id: ctx.run.id, taskId: ctx.run.taskId },
          kind: input.kind,
          notes: input.notes.trim(),
          expiresAt: input.expiresInMinutes ? new Date(now + input.expiresInMinutes * 60_000) : null,
          maxFires: repeating ? (input.maxFires ?? DEFAULT_MAX_FIRES) : 1,
        });
        return {
          ok: true,
          wakeupId: wakeup.id,
          kind: wakeup.kind,
          nextAt: wakeup.nextCheckAt?.toISOString() ?? null,
          expiresAt: wakeup.expiresAt?.toISOString() ?? null,
          maxFires: wakeup.maxFires,
          next: "Saved. End your run now: the task stays in progress until it fires.",
        };
      },
    }),
};

type WaitInput = {
  kind: WakeupRequest["kind"];
  at?: string;
  afterMinutes?: number;
  everyMinutes?: number;
  pullRequestUrl?: string;
  watchTaskId?: string;
  status?: (typeof TASK_STATUSES)[number];
  repeat: boolean;
};

/** What task_wait waits for, checked against the task: its condition and, for a timer, the first time. */
async function waitTarget(
  ctx: Parameters<ToolFactory>[0],
  taskId: string,
  input: WaitInput,
): Promise<Pick<WakeupRequest, "condition" | "at"> | { error: string }> {
  switch (input.kind) {
    case "timer": {
      const every = input.everyMinutes;
      // Without a first time, a repeating timer first fires one period from now.
      const minutes = input.afterMinutes ?? every;
      if (!input.at && !minutes) return { error: "A timer needs at, afterMinutes or everyMinutes." };
      const at = input.at ? new Date(input.at) : new Date(Date.now() + minutes! * 60_000);
      if (at.getTime() <= Date.now()) return { error: `${input.at} is in the past.` };
      return { condition: every ? { everyMinutes: every } : {}, at };
    }
    case "pr_checks_finished":
    case "pr_merged": {
      if (input.kind === "pr_merged" && input.repeat) return { error: "A pull request is merged once: leave repeat out." };
      const pulls = await listTaskPullRequests(taskId);
      const pull = input.pullRequestUrl ? pulls.find((p) => p.url === input.pullRequestUrl) : pulls.at(-1);
      if (!pull) {
        return {
          error: input.pullRequestUrl
            ? `${input.pullRequestUrl} is not a pull request of this task (see task_get).`
            : "This task has no pull request: open one with repo_open_pr first.",
        };
      }
      if (pull.state !== "open") return { error: `Pull request ${pull.url} is already ${pull.state}.` };
      return { condition: { pullRequestId: pull.id }, at: null };
    }
    case "subtasks_done": {
      const [subtask] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, taskId)).limit(1);
      if (!subtask) return { error: "This task has no subtasks to wait for." };
      return { condition: {}, at: null };
    }
    case "task_status": {
      if (!input.watchTaskId || !input.status) return { error: "task_status needs watchTaskId and status." };
      if (input.watchTaskId === taskId) return { error: "A task cannot wait on itself." };
      const watched = await visibleTask(ctx, input.watchTaskId);
      if ("error" in watched) return watched;
      return { condition: { taskId: watched.id, status: input.status }, at: null };
    }
  }
}

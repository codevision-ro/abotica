/**
 * Managing work in flight: pausing, resuming, cancelling or redirecting a task and its subtasks
 * (tasks/control.ts), and the snapshot of a project's open work (tasks/team-status.ts).
 */
import { db, projects, tasks } from "@abotica/db";
import { isUserError } from "@abotica/i18n";
import { tool } from "ai";
import { eq } from "@abotica/db/orm";
import { z } from "zod";
import { cancelTask, pauseTask, redirectTask, resumeTask } from "../../tasks/control";
import { TEAM_STATUS_LIMIT, teamStatus } from "../../tasks/team-status";
import { mayControlTask } from "../../tasks/team-rules";
import { type Task, TASK_PRIORITIES } from "../../tasks/tasks";
import type { RunContext } from "../context";
import {
  agentBySlug,
  blankToUndefined,
  closedProjects,
  errorResult,
  inVisibleProject,
  optionalDateTime,
  optionalId,
  optionalText,
  type ToolFactory,
  visibleProjects,
} from "./shared";
import { withholdClosed } from "./withheld";

/**
 * Whether this run may control work in the project (team-rules.ts mayControlTask): the super agent any,
 * a manager the projects it leads, and inside a project only that one.
 */
export function inControl(ctx: RunContext, projectId: string | null, projectManagerId: string | null): boolean {
  return inVisibleProject(ctx, projectId) && mayControlTask(ctx.agent, { projectManagerId });
}

/** The task when this run may control it (inControl). Never the run's own task: that one it finishes, or asks about. */
async function controllableTask(ctx: RunContext, taskId: string): Promise<Task | { error: string }> {
  const [row] = await db
    .select({ task: tasks, managerAgentId: projects.managerAgentId })
    .from(tasks)
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId));
  if (!row) return { error: `Task ${taskId} does not exist. Use task_list or team_status.` };
  if (row.task.id === ctx.run.taskId) {
    return { error: "This is your own task: finish it, or ask whoever gave it to you about it." };
  }
  if (!inControl(ctx, row.task.projectId, row.managerAgentId)) {
    return { error: `Task ${taskId} is not in a project you lead, so you cannot control it.` };
  }
  return row.task;
}

export const controlTools: Record<string, ToolFactory> = {
  task_control: (ctx) =>
    tool({
      description:
        "Act on a task underway in a project you lead (the super agent: any task). pause: it stops at its next step and keeps its conversation, and the work under it (its subtasks, what it delegated) pauses with it; resume: it goes on there, and that work with it; cancel: it stops for good, with its subtasks unless cascade is false; redirect: new instructions, another assignee, priority or deadline.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        action: z.enum(["pause", "resume", "cancel", "redirect"]),
        reason: z.string().trim().min(1).describe("Why; the assignee and whoever gave the task see it"),
        instructions: optionalText().describe("redirect: what changes in the work"),
        reassignTo: optionalText().describe("redirect: the slug of the agent that takes it over"),
        priority: z.preprocess(blankToUndefined, z.enum(TASK_PRIORITIES).optional()).describe("redirect: a new priority"),
        deadline: optionalDateTime().describe("redirect: a new deadline"),
        cascade: z.boolean().default(true).describe("cancel: its subtasks too"),
        extraContinuations: z
          .preprocess(blankToUndefined, z.number().int().min(1).max(20).optional())
          .describe("resume: more automatic continuations after a step or time limit"),
      }),
      execute: async (input) => {
        const task = await controllableTask(ctx, input.taskId);
        if ("error" in task) return task;
        const by = { agentId: ctx.agent.id };
        try {
          switch (input.action) {
            case "pause": {
              const paused = await pauseTask(task.id, { by, reason: input.reason });
              return {
                taskId: task.id,
                status: paused.status,
                next: "It stops at its next step and keeps its work; resume it with task_control when it should go on.",
              };
            }
            case "resume": {
              const { task: resumed, run } = await resumeTask(task.id, {
                by,
                note: input.instructions ?? input.reason,
                extraContinuations: input.extraContinuations,
              });
              return {
                taskId: task.id,
                status: resumed.status,
                runId: run?.id ?? null,
                ...(run ? {} : { next: "It starts on its own once its dependencies are done or a place frees up." }),
              };
            }
            case "cancel": {
              const { cancelled } = await cancelTask(task.id, { by, reason: input.reason, cascade: input.cascade });
              return { taskId: task.id, cancelled };
            }
            case "redirect": {
              const { instructions, reassignTo, priority, deadline } = input;
              if (!instructions && !reassignTo && !priority && !deadline) {
                return { error: "Say what changes: instructions, reassignTo, priority or deadline." };
              }
              const agent = reassignTo ? await agentBySlug(reassignTo) : undefined;
              if (reassignTo && !agent) return { error: `Agent ${reassignTo} does not exist. Use agent_list.` };
              const redirected = await redirectTask(task.id, {
                by,
                reason: input.reason,
                instructions,
                reassignTo: agent?.id,
                priority,
                deadline: deadline ? new Date(deadline) : undefined,
              });
              return {
                taskId: task.id,
                status: redirected.status,
                assignee: agent?.slug ?? null,
                priority: redirected.priority,
                deadline: redirected.deadline?.toISOString() ?? null,
              };
            }
          }
        } catch (error) {
          if (isUserError(error)) return errorResult(error);
          throw error;
        }
      },
    }),

  team_status: (ctx) =>
    tool({
      description:
        "A project's open work: for each task its assignee, status, priority, deadline, active run, last progress, open questions and what it waits for.",
      inputSchema: z.object({
        projectId: optionalId().describe("Leave out for the project of this run, or every project you lead"),
        includeDone: z.boolean().default(false),
      }),
      execute: async ({ projectId, includeDone }) => {
        // The super agent sees every project (undefined), a manager the ones it leads, or its run's.
        const visible = visibleProjects(ctx);
        if (projectId && visible && !visible.includes(projectId)) {
          return { error: `Project ${projectId} is not one you lead. Leave projectId out for yours.` };
        }
        const [rows, closed] = await Promise.all([
          teamStatus({ projectIds: projectId ? [projectId] : visible }, { includeDone }),
          closedProjects(ctx),
        ]);
        return {
          tasks: rows.map((row) => withholdClosed(row, row.projectId, closed, ["lastProgress"])),
          ...(rows.length === TEAM_STATUS_LIMIT
            ? { truncated: `Only the ${TEAM_STATUS_LIMIT} most urgent tasks are listed; pass a projectId to narrow it.` }
            : {}),
        };
      },
    }),
};

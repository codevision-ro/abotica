/**
 * Managing work in flight: pausing, resuming, cancelling or redirecting a task and its subtasks
 * (tasks/control.ts), and the snapshot of a project's open work (tasks/team-status.ts).
 */
import { tool } from "ai";
import { z } from "zod";
import { TASK_PRIORITIES } from "../../tasks/tasks";
import { blankToUndefined, optionalDateTime, optionalId, optionalText, type ToolFactory } from "./shared";

/** Returned until the mechanism behind the tool is in place. */
const NOT_IMPLEMENTED = { error: "not implemented yet" } as const;

export const controlTools: Record<string, ToolFactory> = {
  task_control: () =>
    tool({
      description:
        "Act on a task underway in a project you lead (the super agent: any task). pause: it stops at its next step and keeps its conversation; resume: it goes on there; cancel: it stops for good, with its subtasks unless cascade is false; redirect: new instructions, another assignee, priority or deadline.",
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
      execute: async () => NOT_IMPLEMENTED,
    }),

  team_status: () =>
    tool({
      description:
        "A project's open work: for each task its assignee, status, priority, deadline, active run, last progress, open questions and what it waits for.",
      inputSchema: z.object({
        projectId: optionalId().describe("Leave out for the project of this run, or every project you lead"),
        includeDone: z.boolean().default(false),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),
};

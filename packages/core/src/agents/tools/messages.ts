/**
 * The task's message stream from the agent's side: asking whoever gave the work without ending the run,
 * answering the questions that come up from below, and reporting progress (tasks/task-messages.ts).
 */
import { tool } from "ai";
import { z } from "zod";
import { blankToUndefined, optionalId, optionalText, type ToolFactory } from "./shared";

/** Returned until the mechanism behind the tool is in place. */
const NOT_IMPLEMENTED = { error: "not implemented yet" } as const;

export const messageTools: Record<string, ToolFactory> = {
  ask: () =>
    tool({
      description:
        "Ask whoever gave you the work a question it must decide (your delegator; the super agent may ask the user). It reaches them at once, while you keep working: go on with what does not depend on the answer, which arrives in this conversation between your steps. When nothing is left to do, end your turn: the answer wakes you.",
      inputSchema: z.object({
        question: z.string().trim().min(1),
        options: z
          .preprocess(blankToUndefined, z.array(z.string().trim().min(1)).max(6).optional())
          .describe("The choices you see, when there are a few"),
        recommendation: optionalText().describe("The option you would pick, and why"),
        taskId: optionalId().describe("The task the question is about; leave out for your own task"),
        to: z.enum(["delegator", "user"]).default("delegator").describe("'user' only for the super agent"),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),

  answer: () =>
    tool({
      description:
        "Answer a question about work you gave (or that came up from below you). The asker gets it at once, mid-run or woken in its conversation. With forward, the question goes one level up instead, for a decision that is not yours.",
      inputSchema: z.object({
        questionId: z.string().uuid(),
        answer: z.string().trim().min(1).describe("The answer; with forward, what you add for the level above"),
        forward: z.boolean().default(false),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),

  report_progress: () =>
    tool({
      description:
        "Tell whoever gave you the task how far the work is, at real milestones. It is read at their next step and does not wake them, unless needsAttention.",
      inputSchema: z.object({
        summary: z.string().trim().min(1),
        percentDone: z.preprocess(blankToUndefined, z.number().int().min(0).max(100).optional()),
        eta: optionalText().describe("When you expect to finish, e.g. 'in about 20 minutes'"),
        needsAttention: z
          .boolean()
          .default(false)
          .describe("True only when it changes the outcome or a date and they should know now"),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),
};

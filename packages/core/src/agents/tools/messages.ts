/**
 * The task's message stream from the agent's side: asking whoever gave the work without ending the run,
 * answering the questions that come up from below, and reporting progress (tasks/task-messages.ts).
 */
import { tool } from "ai";
import { z } from "zod";
import { answerQuestion, askQuestion, reportProgress } from "../../tasks/task-messages";
import { blankToUndefined, errorResult, optionalId, optionalText, type ToolFactory, visibleTask } from "./shared";

type ToolContext = Parameters<ToolFactory>[0];

/**
 * The task the agent asks or reports about: its own (this run's by default), assigned to it. The super
 * agent may ask the user about any task it sees.
 */
async function ownTask(ctx: ToolContext, taskId: string | undefined, opts: { anyVisible?: boolean } = {}) {
  const id = taskId ?? ctx.run.taskId;
  if (!id) return { error: "This run has no task: pass taskId." };
  const task = await visibleTask(ctx, id);
  if ("error" in task) return task;
  if (!opts.anyVisible && task.assigneeAgentId !== ctx.agent.id) {
    return { error: "You can ask or report only about your own task; on others' tasks, write a task_comment." };
  }
  return task;
}

export const messageTools: Record<string, ToolFactory> = {
  ask: (ctx) =>
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
      execute: async ({ question, options, recommendation, taskId, to }) => {
        const orchestrator = ctx.agent.kind === "orchestrator";
        if (to === "user" && !orchestrator) {
          return {
            error: "Your questions go to whoever gave you the task (to: 'delegator'); they pass them up when needed.",
          };
        }
        const task = await ownTask(ctx, taskId, { anyVisible: orchestrator && to === "user" });
        if ("error" in task) return task;
        try {
          const asked = await askQuestion(
            task.id,
            { question, options, recommendation, to },
            { agentId: ctx.agent.id },
            { runId: ctx.run.id },
          );
          return {
            questionId: asked.comment.id,
            delivered: asked.delivered,
            next:
              to === "user"
                ? "It waits in the user's list and they were told. Go on with what does not depend on it; the answer arrives in this conversation."
                : "Go on with what does not depend on it. The answer arrives in this conversation between your steps; if nothing is left to do, end your turn: the answer wakes you.",
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),

  answer: (ctx) =>
    tool({
      description:
        "Answer a question about work you gave (or that came up from below you). The asker gets it at once, mid-run or woken in its conversation. With forward, the question goes one level up instead, for a decision that is not yours.",
      inputSchema: z.object({
        questionId: z.string().uuid(),
        answer: z.string().trim().min(1).describe("The answer; with forward, what you add for the level above"),
        forward: z.boolean().default(false),
      }),
      execute: async ({ questionId, answer, forward }) => {
        try {
          const posted = await answerQuestion(
            questionId,
            answer,
            { agentId: ctx.agent.id },
            { forward, runId: ctx.run.id },
          );
          return forward
            ? { forwarded: true, delivered: posted.delivered }
            : { answered: true, delivered: posted.delivered, ...(posted.error ? { error: posted.error } : {}) };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),

  report_progress: (ctx) =>
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
      execute: async (input) => {
        const task = await ownTask(ctx, undefined);
        if ("error" in task) return task;
        try {
          const posted = await reportProgress(task.id, input, { agentId: ctx.agent.id }, { runId: ctx.run.id });
          return { ok: true, delivered: posted.delivered };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};

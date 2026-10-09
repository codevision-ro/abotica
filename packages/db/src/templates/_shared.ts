import type { AgentLimits, agents } from "../schema";

/**
 * A template's definition, without isTemplate: the seed marks every one. Its prompt is a specialist's
 * profession, the same in every project: no hierarchy, no escalation and no reply rules, which the
 * platform adds for the agent's kind (core agents/kind-prompts.ts, agents/context.ts).
 */
export type AgentTemplate = Omit<typeof agents.$inferInsert, "isTemplate">;

export const limits = (maxSteps: number, minutes: number, budgetUsd: number): AgentLimits => ({
  maxSteps,
  timeoutMs: minutes * 60_000,
  budgetUsd,
});

/** Paragraphs separated by a blank line; a paragraph given as lines keeps them on their own lines. */
export const prompt = (...paragraphs: (string | string[])[]) =>
  paragraphs.map((p) => (Array.isArray(p) ? p.join("\n") : p)).join("\n\n");

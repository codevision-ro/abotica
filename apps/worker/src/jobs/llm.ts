import {
  allowedModelChain,
  estimateCost,
  FallbackModel,
  getSettings,
  NoAllowedProviderError,
  NoModelError,
  projectProviderPolicy,
  reachedBudget,
  resolveModelChain,
} from "@abotica/core";
import { db, runs, type agents } from "@abotica/db";
import { generateText } from "ai";

type Agent = typeof agents.$inferSelect;

/**
 * One-shot LLM call for background jobs (journals, digests, consolidation), on the agent's own model
 * chain limited to the providers `projectId` allows: the project whose data the prompt carries, null
 * for none. Recorded as a "system" run of that project so its cost shows up in tracking and its budget.
 * Null, without a call, once the global monthly budget or the project's is reached.
 */
export async function systemCompletion(input: {
  agent: Agent;
  projectId: string | null;
  purpose: string;
  instructions: string;
  prompt: string;
}) {
  const { agent, projectId, purpose, instructions, prompt } = input;
  const fullChain = resolveModelChain(agent, await getSettings());
  if (!fullChain.length) throw new NoModelError();
  const chain = allowedModelChain(await projectProviderPolicy(projectId), fullChain);
  if (!chain.length) throw new NoAllowedProviderError();
  const reached = await reachedBudget(projectId);
  if (reached) {
    const which = reached.scope === "global" ? "the global monthly budget" : `the monthly budget of ${reached.name}`;
    console.warn(`[maintenance] ${purpose} of ${agent.slug} skipped: ${which} is reached`);
    return null;
  }
  const model = new FallbackModel(chain);
  const startedAt = new Date();
  const result = await generateText({ model, instructions, prompt, maxRetries: 0 });
  const usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
  const served = model.lastServed;
  await db.insert(runs).values({
    agentId: agent.id,
    projectId,
    trigger: "system",
    status: "succeeded",
    input: purpose,
    output: result.text,
    provider: served.provider,
    model: served.model,
    steps: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: await estimateCost(served.provider, served.model, usage),
    startedAt,
    finishedAt: new Date(),
  });
  return result.text.trim();
}

import type { ModelRef } from "@abotica/db";
import { resolveModelChain } from "../models/chain";
import { modelRole } from "../models/model-role";
import { allowedModelChain, runProviderPolicy } from "../models/provider-policy";
import type { RunContext } from "./context";

/** The conversation's model override comes first, then the agent's chain without it. */
export function fullModelChain(ctx: Pick<RunContext, "agent" | "settings" | "conversation">): ModelRef[] {
  const chain = resolveModelChain(ctx.agent, ctx.settings.models, modelRole(ctx.agent));
  const override = ctx.conversation?.modelOverride;
  if (!override) return chain;
  return [override, ...chain.filter((m) => m.provider !== override.provider || m.model !== override.model)];
}

/** The models the run may use: its full chain, limited by the run's provider policy (see runProviderPolicy). */
export async function modelChain(ctx: RunContext): Promise<ModelRef[]> {
  return allowedModelChain(await runProviderPolicy(ctx.projectId, ctx.run.conversationId), fullModelChain(ctx));
}

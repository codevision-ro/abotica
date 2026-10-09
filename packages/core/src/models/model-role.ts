import type { AgentKind, ModelRef, ReasoningEffort } from "@abotica/db";
import type { ModelRole, ModelSettings } from "../settings/settings-schema";

export type { ModelRole };

/**
 * Which default chain an agent without a model of its own runs on, from its kind: a manager runs on
 * the managers' default in every conversation, so its cost is predictable. "agent" is a specialist,
 * whose chain is also the fallback of the other roles.
 */
export type RoleModelSettings = Pick<ModelSettings, "chains">;

export type RoleEffortSettings = Pick<ModelSettings, "reasoningEffort">;

export function modelRole(agent: { kind: AgentKind }): ModelRole {
  return agent.kind === "specialist" ? "agent" : agent.kind;
}

/** The default chain of a role; an empty role chain follows the agents' default. */
export function roleDefaultModels(settings: RoleModelSettings, role: ModelRole): ModelRef[] {
  const own = role === "agent" ? [] : settings.chains[role];
  return own.length ? own : settings.chains.agent;
}

/** The default effort of a role; a role without its own follows the agents' effort. */
export function roleDefaultEffort(settings: RoleEffortSettings, role: ModelRole): ReasoningEffort {
  const own = role === "agent" ? null : settings.reasoningEffort[role];
  return own ?? settings.reasoningEffort.agent;
}

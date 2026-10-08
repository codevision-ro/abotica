import type { AgentKind, ModelRef, ReasoningEffort } from "@abotica/db";
import type { AppSettings } from "../platform/settings";

/**
 * Which default chain an agent without a model of its own runs on, from its kind: a manager runs on
 * the managers' default in every conversation, so its cost is predictable. "agent" is a specialist,
 * whose chain is also the fallback of the other roles.
 */
export type ModelRole = "orchestrator" | "manager" | "agent";

export type RoleModelSettings = Pick<AppSettings, "defaultModels" | "orchestratorModels" | "managerModels">;

export type RoleEffortSettings = Pick<
  AppSettings,
  "defaultReasoningEffort" | "orchestratorReasoningEffort" | "managerReasoningEffort"
>;

export function modelRole(agent: { kind: AgentKind }): ModelRole {
  return agent.kind === "specialist" ? "agent" : agent.kind;
}

/** The default chain of a role; an empty role chain follows the agents' default. */
export function roleDefaultModels(settings: RoleModelSettings, role: ModelRole): ModelRef[] {
  const own = role === "orchestrator" ? settings.orchestratorModels : role === "manager" ? settings.managerModels : [];
  return own.length ? own : settings.defaultModels;
}

/** The default effort of a role; a role without its own follows the agents' effort. */
export function roleDefaultEffort(settings: RoleEffortSettings, role: ModelRole): ReasoningEffort {
  const own =
    role === "orchestrator"
      ? settings.orchestratorReasoningEffort
      : role === "manager"
        ? settings.managerReasoningEffort
        : null;
  return own ?? settings.defaultReasoningEffort;
}

import type { ModelRef, ReasoningEffort } from "@abotica/db";
import type { AppSettings } from "../platform/settings";

/**
 * Which default chain an agent without a model of its own runs on. The role is the agent's, not the
 * run's: a manager runs on the managers' default in every conversation, so its cost is predictable.
 */
export type ModelRole = "orchestrator" | "manager" | "agent";

export type RoleModelSettings = Pick<AppSettings, "defaultModels" | "orchestratorModels" | "managerModels">;

export type RoleEffortSettings = Pick<
  AppSettings,
  "defaultReasoningEffort" | "orchestratorReasoningEffort" | "managerReasoningEffort"
>;

/** The super agent first, then an agent that manages at least one project, then everyone else. */
export function modelRole(agent: { isOrchestrator: boolean }, managesProject: boolean): ModelRole {
  if (agent.isOrchestrator) return "orchestrator";
  return managesProject ? "manager" : "agent";
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

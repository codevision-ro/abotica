/**
 * Who may join a project, who may lead one, what an agent's kind may change to and who may hand work
 * to whom. Pure, so the rules are testable without a database; projects.ts, agent-config.ts, the
 * delegate_task tool, schedules and triggers load the rows and apply them.
 */
import type { AgentKind } from "@abotica/db";

export type { AgentKind };

/** The template every new project's manager is created from. */
export const MANAGER_TEMPLATE_SLUG = "template-project-manager";

export const isOrchestrator = (agent: { kind: AgentKind }) => agent.kind === "orchestrator";

type TeamCandidate = { enabled: boolean; isTemplate: boolean; kind: AgentKind };

/**
 * May join a project's team as a member: an enabled specialist. The super agent stays global, a
 * manager is on the team only of the projects it leads, and templates are blueprints.
 */
export const canJoinTeam = (agent: TeamCandidate) => agent.enabled && !agent.isTemplate && agent.kind === "specialist";

/** May be chosen as a project's manager: an enabled manager, which may already lead other projects. */
export const canLeadProject = (agent: TeamCandidate) => agent.enabled && !agent.isTemplate && agent.kind === "manager";

/** Where the agent stands before its kind changes: projects it leads, and teams it is on without leading them. */
export type KindChange = { from: AgentKind; to: AgentKind; managedProjects: number; memberProjects: number };

/**
 * Null when the agent may change kind, else the message key of the refusal. There is one super agent,
 * whose kind never changes; a manager keeps its kind while it leads a project, and a specialist becomes
 * a manager only off every team, since a manager joins only the projects it leads.
 */
export function kindChangeError(change: KindChange): string | null {
  if (change.from === change.to) return null;
  if (change.from === "orchestrator" || change.to === "orchestrator") return "agents.errors.kindOrchestrator";
  if (change.from === "manager" && change.managedProjects > 0) return "agents.errors.kindLeadsProject";
  if (change.to === "manager" && change.memberProjects > 0) return "agents.errors.kindOnTeam";
  return null;
}

/** The agent giving the work: the super agent, or a manager with the projects it leads. */
export type Delegator = { id: string; kind: AgentKind; managedProjectIds: string[] };

/** The project a delegated task belongs to, with its team. */
export type DelegationProject = {
  id: string;
  name: string;
  managerAgentId: string | null;
  managerSlug: string | null;
  memberIds: string[];
};

export type DelegationTarget = { id: string; slug: string; kind: AgentKind };

type Rule<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * The project a delegated task goes to. `requested` is the project of the call (or of the task
 * being sent again); `runProjectId` the project the delegating run works in. A manager stays in
 * its run's project, and outside one it must name a project it manages.
 */
export function delegationProjectId(
  delegator: Delegator,
  runProjectId: string | null,
  requested: string | null,
): Rule<string | null> {
  const projectId = requested ?? runProjectId;
  if (delegator.kind === "orchestrator") return { ok: true, value: projectId };
  if (delegator.kind === "specialist") {
    return fail(
      "Specialists do not delegate. When the work needs someone else, set your task to 'blocked' with a task_comment saying what is needed.",
    );
  }
  if (runProjectId && projectId !== runProjectId) {
    return fail("You can delegate only within the project of this run.");
  }
  if (!projectId) {
    return fail(
      delegator.managedProjectIds.length
        ? `Say which project the task is for: projectId of a project you manage (${delegator.managedProjectIds.join(", ")}).`
        : "You manage no project, so you cannot delegate.",
    );
  }
  if (!delegator.managedProjectIds.includes(projectId)) return fail(`You do not manage project ${projectId}.`);
  return { ok: true, value: projectId };
}

/**
 * Whether the delegator may give a task in `project` (null: outside projects) to `target`. The super
 * agent reaches a project only through its manager; a manager hands work to the other members of the
 * projects it manages.
 */
export function checkDelegationTarget(
  delegator: Delegator,
  target: DelegationTarget,
  project: DelegationProject | null,
): Rule<null> {
  if (target.id === delegator.id) return fail("You cannot delegate to yourself: do the work in this run instead.");
  if (target.kind === "orchestrator") return fail("The super agent does not take delegated tasks.");
  if (delegator.kind === "orchestrator") {
    if (!project || project.managerAgentId === target.id) return { ok: true, value: null };
    if (!project.managerAgentId) {
      return fail(
        `Project ${project.name} has no manager, so no work can be delegated in it. Tell the user to choose or create a manager in the project's Team tab.`,
      );
    }
    return fail(
      `Work in project ${project.name} goes to its manager, ${project.managerSlug}: delegate to ${project.managerSlug} with the outcome wanted; the manager decides who on the team does what.`,
    );
  }
  if (delegator.kind !== "manager" || !project || project.managerAgentId !== delegator.id) {
    return fail("You can delegate only in projects you manage.");
  }
  if (!project.memberIds.includes(target.id) || target.kind !== "specialist") {
    return fail(
      `${target.slug} is not on the ${project.name} team. Delegate to a team member, or say in your report which specialist the team lacks.`,
    );
  }
  return { ok: true, value: null };
}

/**
 * Whether the delegator may set up a schedule or trigger that runs `target` in `project`: for itself
 * outside projects or in a project whose team it is on, otherwise only what delegate_task would allow.
 */
export function checkAutomationTarget(
  delegator: Delegator,
  target: DelegationTarget,
  project: DelegationProject | null,
): Rule<null> {
  if (target.id !== delegator.id) return checkDelegationTarget(delegator, target, project);
  if (!project || worksIn(delegator, project)) return { ok: true, value: null };
  return fail(`You are not on the ${project.name} team, so you cannot run in it.`);
}

/**
 * Whether the agent may run in the project: it is on the team (the manager or a member). The super
 * agent works outside projects (see loadRunContext), so a project changes nothing for it.
 */
export function worksIn(
  agent: { id: string; kind: AgentKind },
  project: Pick<DelegationProject, "managerAgentId" | "memberIds">,
): boolean {
  return agent.kind === "orchestrator" || project.managerAgentId === agent.id || project.memberIds.includes(agent.id);
}

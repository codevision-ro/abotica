/**
 * Who may join a project and who may hand work to whom. Pure, so the rules are testable without a
 * database; projects.ts, the delegate_task tool, schedules and triggers load the rows and apply them.
 */

/** The template every new project's manager is created from. */
export const MANAGER_TEMPLATE_SLUG = "template-project-manager";

/** The super agent stays global and templates are blueprints: neither joins a project. */
export const isAssignable = (agent: { enabled: boolean; isTemplate: boolean; isOrchestrator: boolean }) =>
  agent.enabled && !agent.isTemplate && !agent.isOrchestrator;

/** The agent giving the work: the super agent, or an agent with the projects it manages. */
export type Delegator = { id: string; isOrchestrator: boolean; managedProjectIds: string[] };

/** The project a delegated task belongs to, with its team. */
export type DelegationProject = {
  id: string;
  name: string;
  managerAgentId: string | null;
  managerSlug: string | null;
  memberIds: string[];
};

export type DelegationTarget = { id: string; slug: string; isOrchestrator: boolean };

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
  if (delegator.isOrchestrator) return { ok: true, value: projectId };
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
  if (target.isOrchestrator) return fail("The super agent does not take delegated tasks.");
  if (delegator.isOrchestrator) {
    if (!project || project.managerAgentId === target.id) return { ok: true, value: null };
    if (!project.managerAgentId) {
      return fail(
        `Project ${project.name} has no manager, so no work can be delegated in it. Tell the user to choose or create a manager in the project's Team tab.`,
      );
    }
    return fail(
      `Work in project ${project.name} goes to its manager, ${project.managerSlug}: delegate to ${project.managerSlug} and say in the description which team member should do what, if it matters.`,
    );
  }
  if (!project || project.managerAgentId !== delegator.id) return fail("You can delegate only in projects you manage.");
  if (!project.memberIds.includes(target.id)) {
    return fail(`${target.slug} is not on the ${project.name} team. Delegate to a team member or do it yourself.`);
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
  agent: { id: string; isOrchestrator: boolean },
  project: Pick<DelegationProject, "managerAgentId" | "memberIds">,
): boolean {
  return agent.isOrchestrator || project.managerAgentId === agent.id || project.memberIds.includes(agent.id);
}

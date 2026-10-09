/**
 * Who may join a project, who may lead one, what an agent's kind may change to, who may hand work to
 * whom, and who may change, instruct, control or answer on a task. Pure, so the rules are testable
 * without a database; projects.ts, agent-config.ts, the task tools, schedules and triggers load the rows
 * and apply them.
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

/** Who acts on a task: the user (from the web or Telegram), or an agent with its kind. */
export type TeamActor = "user" | { id: string; kind: AgentKind };

/** Who stands above a task: the agent whose run delegated it, and its project's manager. */
export type TaskAuthority = { delegatorAgentId: string | null; projectManagerId: string | null };

type TaskRef = { assigneeAgentId: string | null };

/** The user, the super agent, the task's delegator or its project's manager: those who decide on a task. */
function decides(actor: TeamActor, authority: TaskAuthority): boolean {
  if (actor === "user" || actor.kind === "orchestrator") return true;
  return actor.id === authority.delegatorAgentId || actor.id === authority.projectManagerId;
}

/**
 * May change the task (task_update): the assignee (its output and status, within the tool's own rules)
 * and those who decide on it. A peer on the team only comments.
 */
export function mayEditTask(actor: TeamActor, task: TaskRef, authority: TaskAuthority): boolean {
  return decides(actor, authority) || (actor !== "user" && actor.id === task.assigneeAgentId);
}

/**
 * Whether what the actor writes on the task is an instruction its assignee gets at once: the user, the
 * super agent, the task's delegator and its project's manager give instructions. The assignee's own
 * comments and a peer's are notes.
 */
export function mayInstruct(actor: TeamActor, task: TaskRef, authority: TaskAuthority): boolean {
  if (actor !== "user" && actor.id === task.assigneeAgentId) return false;
  return decides(actor, authority);
}

/**
 * May pause, resume, cancel or redirect the task (task_control): the user and the super agent any task, a
 * manager the tasks of the projects it leads.
 */
export function mayControlTask(actor: TeamActor, authority: Pick<TaskAuthority, "projectManagerId">): boolean {
  if (actor === "user" || actor.kind === "orchestrator") return true;
  return actor.kind === "manager" && actor.id === authority.projectManagerId;
}

/** Open help tasks one task may have at once (ask_colleague). */
export const MAX_OPEN_HELP_TASKS = 2;

/**
 * Whether `asker` may ask `target` for help (ask_colleague) while on `askerTask`: work (not itself help,
 * so help does not chain) in a project, to an enabled specialist on that project's team other than
 * itself, with fewer than MAX_OPEN_HELP_TASKS help tasks open.
 */
export function mayAskColleague(
  asker: { id: string },
  target: TeamCandidate & { id: string; slug: string },
  project: Pick<DelegationProject, "name" | "memberIds"> | null,
  askerTask: { kind: "work" | "help"; projectId: string | null; openHelpTasks: number } | null,
): Rule<null> {
  if (!askerTask || !askerTask.projectId || !project) {
    return fail("You can ask a colleague only while working on a task in a project.");
  }
  if (askerTask.kind === "help") {
    return fail("You are answering a colleague's question: answer it yourself, or say what you could not find out.");
  }
  if (target.id === asker.id) return fail("You cannot ask yourself.");
  if (!canJoinTeam(target) || !project.memberIds.includes(target.id)) {
    return fail(`${target.slug} is not a specialist on the ${project.name} team. Ask a member of the team.`);
  }
  if (askerTask.openHelpTasks >= MAX_OPEN_HELP_TASKS) {
    return fail(
      `Your task already waits for ${askerTask.openHelpTasks} colleagues' answers: wait for them before asking more.`,
    );
  }
  return { ok: true, value: null };
}

/**
 * May answer a question: the user, the agent it is addressed to, and the agents above that one in the
 * asker's chain of command (`chain`: agent ids going up from the asker's task, nearest first). Once the
 * question reached the user, only the user answers it.
 */
export function mayAnswer(
  actor: TeamActor,
  question: { addresseeAgentId: string | null; addressedToUser: boolean },
  chain: readonly string[],
): boolean {
  if (actor === "user") return true;
  if (question.addressedToUser || !question.addresseeAgentId) return false;
  if (actor.id === question.addresseeAgentId) return true;
  const addressee = chain.indexOf(question.addresseeAgentId);
  return addressee >= 0 && chain.indexOf(actor.id) > addressee;
}

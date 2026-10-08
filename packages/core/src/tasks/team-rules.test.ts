import { describe, expect, it } from "vitest";
import {
  checkAutomationTarget,
  checkDelegationTarget,
  type DelegationProject,
  type Delegator,
  canJoinTeam,
  canLeadProject,
  delegationProjectId,
  kindChangeError,
  worksIn,
} from "./team-rules";

const superAgent: Delegator = { id: "super", kind: "orchestrator", managedProjectIds: [] };
const manager: Delegator = { id: "manager", kind: "manager", managedProjectIds: ["p1", "p2"] };
const specialist: Delegator = { id: "dev", kind: "specialist", managedProjectIds: [] };

const project: DelegationProject = {
  id: "p1",
  name: "Site",
  managerAgentId: "manager",
  managerSlug: "site-manager",
  memberIds: ["manager", "dev"],
};
const target = (id: string, kind: Delegator["kind"] = "specialist") => ({ id, slug: `${id}-slug`, kind });

describe("canJoinTeam and canLeadProject", () => {
  const agent = { enabled: true, isTemplate: false } as const;

  it("lets only enabled, real specialists join a team", () => {
    expect(canJoinTeam({ ...agent, kind: "specialist" })).toBe(true);
    expect(canJoinTeam({ ...agent, kind: "manager" })).toBe(false);
    expect(canJoinTeam({ ...agent, kind: "orchestrator" })).toBe(false);
    expect(canJoinTeam({ ...agent, enabled: false, kind: "specialist" })).toBe(false);
    expect(canJoinTeam({ ...agent, isTemplate: true, kind: "specialist" })).toBe(false);
  });

  it("lets only enabled, real managers lead a project", () => {
    expect(canLeadProject({ ...agent, kind: "manager" })).toBe(true);
    expect(canLeadProject({ ...agent, kind: "specialist" })).toBe(false);
    expect(canLeadProject({ ...agent, kind: "orchestrator" })).toBe(false);
    expect(canLeadProject({ ...agent, isTemplate: true, kind: "manager" })).toBe(false);
  });
});

describe("kindChangeError", () => {
  const change = { managedProjects: 0, memberProjects: 0 };

  it("never makes or unmakes the super agent", () => {
    expect(kindChangeError({ ...change, from: "orchestrator", to: "manager" })).toBe("agents.errors.kindOrchestrator");
    expect(kindChangeError({ ...change, from: "specialist", to: "orchestrator" })).toBe("agents.errors.kindOrchestrator");
    expect(kindChangeError({ ...change, from: "orchestrator", to: "orchestrator" })).toBeNull();
  });

  it("keeps a manager that leads a project a manager", () => {
    expect(kindChangeError({ ...change, from: "manager", to: "specialist", managedProjects: 1 })).toBe(
      "agents.errors.kindLeadsProject",
    );
    expect(kindChangeError({ ...change, from: "manager", to: "specialist" })).toBeNull();
  });

  it("makes a specialist a manager only off every team", () => {
    expect(kindChangeError({ ...change, from: "specialist", to: "manager", memberProjects: 2 })).toBe(
      "agents.errors.kindOnTeam",
    );
    expect(kindChangeError({ ...change, from: "specialist", to: "manager" })).toBeNull();
  });
});

describe("delegationProjectId", () => {
  it("lets the super agent pick any project or none", () => {
    expect(delegationProjectId(superAgent, null, "p9")).toEqual({ ok: true, value: "p9" });
    expect(delegationProjectId(superAgent, null, null)).toEqual({ ok: true, value: null });
  });

  it("keeps a manager in its run's project", () => {
    expect(delegationProjectId(manager, "p1", null)).toEqual({ ok: true, value: "p1" });
    expect(delegationProjectId(manager, "p1", "p1")).toEqual({ ok: true, value: "p1" });
    expect(delegationProjectId(manager, "p1", "p2").ok).toBe(false);
  });

  it("outside a project, a manager names one it manages", () => {
    expect(delegationProjectId(manager, null, "p2")).toEqual({ ok: true, value: "p2" });
    expect(delegationProjectId(manager, null, "p9").ok).toBe(false);
    expect(delegationProjectId(manager, null, null).ok).toBe(false);
  });

  it("refuses specialists and agents that manage nothing", () => {
    expect(delegationProjectId(specialist, "p1", null).ok).toBe(false);
    expect(delegationProjectId({ ...manager, managedProjectIds: [] }, null, null).ok).toBe(false);
  });
});

describe("checkDelegationTarget", () => {
  it("sends the super agent's project work to the manager only", () => {
    expect(checkDelegationTarget(superAgent, target("manager", "manager"), project).ok).toBe(true);
    const refused = checkDelegationTarget(superAgent, target("dev"), project);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("site-manager");
  });

  it("tells the super agent when a project has no manager", () => {
    const refused = checkDelegationTarget(superAgent, target("dev"), {
      ...project,
      managerAgentId: null,
      managerSlug: null,
    });
    expect(!refused.ok && refused.error).toContain("no manager");
  });

  it("lets the super agent delegate outside projects", () => {
    expect(checkDelegationTarget(superAgent, target("dev"), null).ok).toBe(true);
  });

  it("lets a manager delegate to members of its project only", () => {
    expect(checkDelegationTarget(manager, target("dev"), project).ok).toBe(true);
    expect(checkDelegationTarget(manager, target("outsider"), project).ok).toBe(false);
    expect(checkDelegationTarget(manager, target("dev"), { ...project, managerAgentId: "other" }).ok).toBe(false);
    expect(checkDelegationTarget(manager, target("dev"), null).ok).toBe(false);
  });

  it("never delegates to oneself or to the super agent", () => {
    expect(checkDelegationTarget(manager, target("manager", "manager"), project).ok).toBe(false);
    expect(checkDelegationTarget(manager, target("super", "orchestrator"), { ...project, memberIds: ["super"] }).ok).toBe(
      false,
    );
    expect(checkDelegationTarget(superAgent, target("super", "orchestrator"), null).ok).toBe(false);
  });

  it("keeps a manager from delegating to another manager", () => {
    expect(checkDelegationTarget(manager, target("dev", "manager"), project).ok).toBe(false);
  });

  it("refuses specialists", () => {
    expect(checkDelegationTarget(specialist, target("manager", "manager"), project).ok).toBe(false);
    expect(checkDelegationTarget({ ...specialist, managedProjectIds: ["p1"] }, target("x"), project).ok).toBe(false);
  });
});

describe("checkAutomationTarget", () => {
  it("lets an agent schedule itself outside projects or in a project whose team it is on", () => {
    expect(checkAutomationTarget(specialist, target("dev"), null).ok).toBe(true);
    expect(checkAutomationTarget(specialist, target("dev"), project).ok).toBe(true);
    expect(checkAutomationTarget(manager, target("manager", "manager"), project).ok).toBe(true);
    expect(checkAutomationTarget(specialist, target("dev"), { ...project, memberIds: ["manager"] }).ok).toBe(false);
  });

  it("lets the super agent schedule itself in any project", () => {
    expect(checkAutomationTarget(superAgent, target("super", "orchestrator"), project).ok).toBe(true);
  });

  it("holds runs of other agents to the delegation rules", () => {
    expect(checkAutomationTarget(superAgent, target("manager", "manager"), project).ok).toBe(true);
    expect(checkAutomationTarget(superAgent, target("dev"), project).ok).toBe(false);
    expect(checkAutomationTarget(manager, target("dev"), project).ok).toBe(true);
    expect(checkAutomationTarget(manager, target("outsider"), project).ok).toBe(false);
    expect(checkAutomationTarget(specialist, target("manager", "manager"), project).ok).toBe(false);
    expect(checkAutomationTarget(specialist, target("manager", "manager"), null).ok).toBe(false);
  });
});

describe("worksIn", () => {
  it("accepts the project's manager and members", () => {
    expect(worksIn({ id: "manager", kind: "manager" }, project)).toBe(true);
    expect(worksIn({ id: "dev", kind: "specialist" }, project)).toBe(true);
  });

  it("refuses agents off the team", () => {
    expect(worksIn({ id: "outsider", kind: "specialist" }, project)).toBe(false);
  });

  it("accepts the super agent, which works outside projects anyway", () => {
    expect(worksIn({ id: "super", kind: "orchestrator" }, project)).toBe(true);
  });
});

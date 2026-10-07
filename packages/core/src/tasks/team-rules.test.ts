import { describe, expect, it } from "vitest";
import {
  checkAutomationTarget,
  checkDelegationTarget,
  type DelegationProject,
  type Delegator,
  delegationProjectId,
  isAssignable,
  worksIn,
} from "./team-rules";

const superAgent: Delegator = { id: "super", isOrchestrator: true, managedProjectIds: [] };
const manager: Delegator = { id: "manager", isOrchestrator: false, managedProjectIds: ["p1", "p2"] };
const specialist: Delegator = { id: "dev", isOrchestrator: false, managedProjectIds: [] };

const project: DelegationProject = {
  id: "p1",
  name: "Site",
  managerAgentId: "manager",
  managerSlug: "site-manager",
  memberIds: ["manager", "dev"],
};
const target = (id: string, isOrchestrator = false) => ({ id, slug: `${id}-slug`, isOrchestrator });

describe("isAssignable", () => {
  it("accepts only enabled, real, non-orchestrator agents", () => {
    expect(isAssignable({ enabled: true, isTemplate: false, isOrchestrator: false })).toBe(true);
    expect(isAssignable({ enabled: false, isTemplate: false, isOrchestrator: false })).toBe(false);
    expect(isAssignable({ enabled: true, isTemplate: true, isOrchestrator: false })).toBe(false);
    expect(isAssignable({ enabled: true, isTemplate: false, isOrchestrator: true })).toBe(false);
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

  it("refuses agents that manage nothing", () => {
    expect(delegationProjectId(specialist, "p1", null).ok).toBe(false);
  });
});

describe("checkDelegationTarget", () => {
  it("sends the super agent's project work to the manager only", () => {
    expect(checkDelegationTarget(superAgent, target("manager"), project).ok).toBe(true);
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
    expect(checkDelegationTarget(manager, target("manager"), project).ok).toBe(false);
    expect(checkDelegationTarget(manager, target("super", true), { ...project, memberIds: ["super"] }).ok).toBe(false);
    expect(checkDelegationTarget(superAgent, target("super", true), null).ok).toBe(false);
  });

  it("refuses agents that are neither super agent nor manager", () => {
    expect(checkDelegationTarget(specialist, target("manager"), project).ok).toBe(false);
  });
});

describe("checkAutomationTarget", () => {
  it("lets an agent schedule itself outside projects or in a project whose team it is on", () => {
    expect(checkAutomationTarget(specialist, target("dev"), null).ok).toBe(true);
    expect(checkAutomationTarget(specialist, target("dev"), project).ok).toBe(true);
    expect(checkAutomationTarget(manager, target("manager"), project).ok).toBe(true);
    expect(checkAutomationTarget(specialist, target("dev"), { ...project, memberIds: ["manager"] }).ok).toBe(false);
  });

  it("lets the super agent schedule itself in any project", () => {
    expect(checkAutomationTarget(superAgent, target("super", true), project).ok).toBe(true);
  });

  it("holds runs of other agents to the delegation rules", () => {
    expect(checkAutomationTarget(superAgent, target("manager"), project).ok).toBe(true);
    expect(checkAutomationTarget(superAgent, target("dev"), project).ok).toBe(false);
    expect(checkAutomationTarget(manager, target("dev"), project).ok).toBe(true);
    expect(checkAutomationTarget(manager, target("outsider"), project).ok).toBe(false);
    expect(checkAutomationTarget(specialist, target("manager"), project).ok).toBe(false);
    expect(checkAutomationTarget(specialist, target("manager"), null).ok).toBe(false);
  });
});

describe("worksIn", () => {
  it("accepts the project's manager and members", () => {
    expect(worksIn({ id: "manager", isOrchestrator: false }, project)).toBe(true);
    expect(worksIn({ id: "dev", isOrchestrator: false }, project)).toBe(true);
  });

  it("refuses agents off the team", () => {
    expect(worksIn({ id: "outsider", isOrchestrator: false }, project)).toBe(false);
  });

  it("accepts the super agent, which works outside projects anyway", () => {
    expect(worksIn({ id: "super", isOrchestrator: true }, project)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { nothingNewRefusal, reportTargetOf } from "./automation-rules";

const MANAGER = { id: "m1", enabled: true };

describe("reportTargetOf", () => {
  it("sends a specialist's work to the project's manager", () => {
    expect(reportTargetOf({ id: "s1", kind: "specialist" }, MANAGER)).toBe("manager");
  });

  it("sends it to the super agent without an enabled manager", () => {
    expect(reportTargetOf({ id: "s1", kind: "specialist" }, null)).toBe("orchestrator");
    expect(reportTargetOf({ id: "s1", kind: "specialist" }, { ...MANAGER, enabled: false })).toBe("orchestrator");
  });

  it("sends a manager's work to the super agent, even in a project it leads", () => {
    expect(reportTargetOf({ id: "m1", kind: "manager" }, MANAGER)).toBe("orchestrator");
    expect(reportTargetOf({ id: "m2", kind: "manager" }, MANAGER)).toBe("orchestrator");
  });

  it("has nobody above the super agent", () => {
    expect(reportTargetOf({ id: "o1", kind: "orchestrator" }, MANAGER)).toBeNull();
  });
});

describe("nothingNewRefusal", () => {
  const fired = { reportsUp: true, delegatedByRunId: null, assigneeAgentId: "s1", status: "in_progress" };

  it("lets the assignee end fired work while it runs", () => {
    expect(nothingNewRefusal(fired, "s1")).toBeNull();
  });

  it("refuses delegated or user tasks", () => {
    expect(nothingNewRefusal({ ...fired, reportsUp: false }, "s1")).toContain("schedule or trigger");
  });

  it("refuses work sent back with a fix: the sender waits for the answer", () => {
    expect(nothingNewRefusal({ ...fired, delegatedByRunId: "r1" }, "s1")).toContain("sent back");
  });

  it("refuses anyone but the assignee", () => {
    expect(nothingNewRefusal(fired, "m1")).toContain("assigned");
  });

  it("refuses work no longer in progress", () => {
    expect(nothingNewRefusal({ ...fired, status: "blocked" }, "s1")).toContain("blocked");
  });
});

import { describe, expect, it } from "vitest";
import { defaultMemoryScope, memoryEditableBy, memoryVisibleTo } from "./memory-scope";

const inProject = { agentId: "dev", projectId: "p1" };
const outside = { agentId: "dev", projectId: null };

const global = { scope: "global" as const, agentId: null, projectId: null };
const own = { scope: "agent" as const, agentId: "dev", projectId: null };
const someoneElses = { scope: "agent" as const, agentId: "seo", projectId: null };
const thisProject = { scope: "project" as const, agentId: "seo", projectId: "p1" };
const otherProject = { scope: "project" as const, agentId: "dev", projectId: "p2" };

describe("memoryVisibleTo", () => {
  it("reads global, own and the run's project memory", () => {
    expect(memoryVisibleTo(global, inProject)).toBe(true);
    expect(memoryVisibleTo(own, inProject)).toBe(true);
    expect(memoryVisibleTo(thisProject, inProject)).toBe(true);
  });

  it("never reads another project's memory, not even what the agent wrote there", () => {
    expect(memoryVisibleTo(otherProject, inProject)).toBe(false);
    expect(memoryVisibleTo(otherProject, outside)).toBe(false);
    expect(memoryVisibleTo(thisProject, outside)).toBe(false);
  });

  it("never reads another agent's own memory", () => {
    expect(memoryVisibleTo(someoneElses, inProject)).toBe(false);
  });
});

describe("memoryEditableBy", () => {
  it("leaves global memory to the orchestrator", () => {
    expect(memoryEditableBy(global, { ...inProject, isOrchestrator: false })).toBe(false);
    expect(memoryEditableBy(global, { agentId: "super", projectId: null, isOrchestrator: true })).toBe(true);
  });

  it("changes own memory and the run's project memory only", () => {
    const editor = { ...inProject, isOrchestrator: false };
    expect(memoryEditableBy(own, editor)).toBe(true);
    expect(memoryEditableBy(thisProject, editor)).toBe(true);
    expect(memoryEditableBy(otherProject, editor)).toBe(false);
    expect(memoryEditableBy(someoneElses, editor)).toBe(false);
  });
});

describe("defaultMemoryScope", () => {
  it("saves to the project inside one and to the agent outside", () => {
    expect(defaultMemoryScope("p1")).toBe("project");
    expect(defaultMemoryScope(null)).toBe("agent");
  });
});

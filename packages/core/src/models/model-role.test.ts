import { describe, expect, it } from "vitest";
import { modelRole, roleDefaultEffort, roleDefaultModels } from "./model-role";

const AGENTS = [{ provider: "deepseek", model: "chat" }];
const MANAGERS = [{ provider: "openai", model: "gpt" }];
const ORCHESTRATOR = [{ provider: "anthropic", model: "opus" }];
const settings = { defaultModels: AGENTS, orchestratorModels: ORCHESTRATOR, managerModels: MANAGERS };

describe("modelRole", () => {
  it("makes the super agent an orchestrator even when it leads a project", () => {
    expect(modelRole({ isOrchestrator: true }, false)).toBe("orchestrator");
    expect(modelRole({ isOrchestrator: true }, true)).toBe("orchestrator");
  });

  it("makes an agent that manages a project a manager, and any other an agent", () => {
    expect(modelRole({ isOrchestrator: false }, true)).toBe("manager");
    expect(modelRole({ isOrchestrator: false }, false)).toBe("agent");
  });
});

describe("roleDefaultModels", () => {
  it("gives each role its own chain", () => {
    expect(roleDefaultModels(settings, "orchestrator")).toEqual(ORCHESTRATOR);
    expect(roleDefaultModels(settings, "manager")).toEqual(MANAGERS);
    expect(roleDefaultModels(settings, "agent")).toEqual(AGENTS);
  });

  it("falls back to the agents' chain for a role whose chain is empty", () => {
    const unset = { defaultModels: AGENTS, orchestratorModels: [], managerModels: [] };
    expect(roleDefaultModels(unset, "orchestrator")).toEqual(AGENTS);
    expect(roleDefaultModels(unset, "manager")).toEqual(AGENTS);
  });
});

describe("roleDefaultEffort", () => {
  const efforts = {
    defaultReasoningEffort: "medium",
    orchestratorReasoningEffort: "low",
    managerReasoningEffort: null,
  } as const;

  it("gives a role its own effort, and the agents' effort to a role without one", () => {
    expect(roleDefaultEffort(efforts, "orchestrator")).toBe("low");
    expect(roleDefaultEffort(efforts, "manager")).toBe("medium");
    expect(roleDefaultEffort(efforts, "agent")).toBe("medium");
  });

  it("keeps a role's own choice to let the model decide", () => {
    expect(roleDefaultEffort({ ...efforts, managerReasoningEffort: "default" }, "manager")).toBe("default");
  });
});

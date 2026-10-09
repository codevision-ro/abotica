import { describe, expect, it } from "vitest";
import { kindPrompt } from "./kind-prompts";

/**
 * The kind prompts open every system prompt, so a change to them changes every agent's behaviour: the
 * snapshots make each one a reviewed change.
 */
describe("kindPrompt", () => {
  it.each(["orchestrator", "manager", "specialist"] as const)("is stable for the %s", (kind) => {
    expect(kindPrompt(kind)).toMatchSnapshot();
  });

  it("puts changes to delegated work on the task, not in a new delegation", () => {
    expect(kindPrompt("orchestrator")).toContain("do not delegate it again: put the change on the task you gave");
    expect(kindPrompt("manager")).toContain("apply them to the work underway at once");
    expect(kindPrompt("specialist")).toContain("the latest instruction wins over the brief");
  });

  it("asks instead of blocking, and blocks only on what cannot be done", () => {
    expect(kindPrompt("specialist")).toContain("ask: it reaches whoever gave you the task at once");
    expect(kindPrompt("specialist")).toContain("only when it cannot be done as briefed");
    expect(kindPrompt("manager")).toContain("ask on your task");
    expect(kindPrompt("manager")).not.toContain("set it to 'blocked' or 'review'");
  });

  it("never brings back an approval gate", () => {
    for (const kind of ["orchestrator", "manager", "specialist"] as const) {
      expect(kindPrompt(kind)).not.toMatch(/must be asked|ask for approval|before publishing|before deleting/i);
    }
  });
});

import { describe, expect, it } from "vitest";
import { externalIdOf, runFinishedNotice } from "./routing";

describe("externalIdOf", () => {
  it("keys a conversation by chat, and by topic or thread inside it", () => {
    expect(externalIdOf(-100, undefined)).toBe("-100");
    expect(externalIdOf(-100, 42)).toBe("-100:42");
  });
});

describe("runFinishedNotice", () => {
  it("notifies the super agent's schedule, webhook and task runs", () => {
    expect(runFinishedNotice({ trigger: "schedule", status: "succeeded" }, "orchestrator")).toBe("succeeded");
    expect(runFinishedNotice({ trigger: "webhook", status: "failed" }, "orchestrator")).toBe("failed");
  });

  it("never notifies for managers and specialists, nor deleted agents", () => {
    expect(runFinishedNotice({ trigger: "task", status: "succeeded" }, "manager")).toBeNull();
    expect(runFinishedNotice({ trigger: "schedule", status: "failed" }, "specialist")).toBeNull();
    expect(runFinishedNotice({ trigger: "schedule", status: "failed" }, null)).toBeNull();
  });

  it("skips system runs and chat answers, but reports a failed chat run", () => {
    expect(runFinishedNotice({ trigger: "system", status: "failed" }, "orchestrator")).toBeNull();
    expect(runFinishedNotice({ trigger: "telegram", status: "succeeded" }, "orchestrator")).toBeNull();
    expect(runFinishedNotice({ trigger: "chat", status: "failed" }, "orchestrator")).toBe("failed");
  });
});

import { describe, expect, it } from "vitest";
import { runFinishedNotice } from "./routing";

describe("runFinishedNotice", () => {
  it("notifies the super agent's schedule, webhook and task runs", () => {
    expect(runFinishedNotice({ trigger: "schedule", status: "succeeded" }, "orchestrator")).toBe("succeeded");
    expect(runFinishedNotice({ trigger: "webhook", status: "failed" }, "orchestrator")).toBe("failed");
  });

  it("never notifies for managers' and specialists' runs outside the user's tasks, nor deleted agents", () => {
    expect(runFinishedNotice({ trigger: "task", status: "succeeded" }, "manager")).toBeNull();
    expect(runFinishedNotice({ trigger: "schedule", status: "failed" }, "specialist")).toBeNull();
    expect(runFinishedNotice({ trigger: "schedule", status: "failed" }, null)).toBeNull();
  });
});

describe("runFinishedNotice on a task the user gave a manager or a specialist", () => {
  const own = { status: "review", createdBy: "user", delegatedByRunId: null, reportsUp: false } as const;
  const run = { trigger: "task", status: "succeeded" } as const;

  it("tells the user once the task is ready, blocked or failed", () => {
    expect(runFinishedNotice(run, "specialist", own)).toBe("succeeded");
    expect(runFinishedNotice(run, "manager", { ...own, status: "done" })).toBe("succeeded");
    expect(runFinishedNotice(run, "specialist", { ...own, status: "blocked" })).toBe("blocked");
    expect(runFinishedNotice({ ...run, status: "failed" }, "manager", { ...own, status: "blocked" })).toBe("failed");
  });

  it("stays quiet while the task is still in progress", () => {
    expect(runFinishedNotice(run, "manager", { ...own, status: "in_progress" })).toBeNull();
    expect(runFinishedNotice({ ...run, status: "waiting_approval" }, "specialist", own)).toBeNull();
  });

  it("leaves work that reports up to the hierarchy", () => {
    expect(runFinishedNotice(run, "specialist", { ...own, createdBy: "agent:abotica" })).toBeNull();
    expect(runFinishedNotice(run, "specialist", { ...own, delegatedByRunId: "r1" })).toBeNull();
    expect(runFinishedNotice(run, "specialist", { ...own, reportsUp: true })).toBeNull();
  });

  it("skips system runs and chat answers, but reports a failed chat run", () => {
    expect(runFinishedNotice({ trigger: "system", status: "failed" }, "orchestrator")).toBeNull();
    expect(runFinishedNotice({ trigger: "telegram", status: "succeeded" }, "orchestrator")).toBeNull();
    expect(runFinishedNotice({ trigger: "chat", status: "failed" }, "orchestrator")).toBe("failed");
  });
});

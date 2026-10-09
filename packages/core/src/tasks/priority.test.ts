import { describe, expect, it } from "vitest";
import { queuePriority } from "./priority";

describe("queuePriority", () => {
  it("puts a person waiting in a chat first, whatever the task", () => {
    expect(queuePriority({ trigger: "chat" })).toBe(1);
    expect(queuePriority({ trigger: "telegram", taskPriority: "low" })).toBe(1);
  });

  it("ranks task work by its priority", () => {
    expect(queuePriority({ trigger: "delegation", taskPriority: "urgent" })).toBe(2);
    expect(queuePriority({ trigger: "task", taskPriority: "high" })).toBe(3);
    expect(queuePriority({ trigger: "task", taskPriority: "medium" })).toBe(4);
    expect(queuePriority({ trigger: "schedule", taskPriority: "low" })).toBe(5);
  });

  it("runs work without a priority as medium, and the platform's own last", () => {
    expect(queuePriority({ trigger: "webhook" })).toBe(4);
    expect(queuePriority({ trigger: "system", taskPriority: "urgent" })).toBe(6);
  });

  it("takes the higher of the task's priority and the notice's", () => {
    expect(queuePriority({ trigger: "delegation", taskPriority: "low", noticePriority: "urgent" })).toBe(2);
    expect(queuePriority({ trigger: "delegation", taskPriority: "high", noticePriority: "low" })).toBe(3);
    expect(queuePriority({ trigger: "delegation", taskPriority: null, noticePriority: "high" })).toBe(3);
  });
});

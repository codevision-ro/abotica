import { describe, expect, it } from "vitest";
import { isPlatformNotice, isTaskNotice } from "./task-notices";

describe("task notices", () => {
  const notice = {
    kind: "task-notice",
    notice: "instruction",
    taskId: "t1",
    taskTitle: "Homepage",
    projectId: null,
    from: "Manager",
  };

  it("tells a task notice from other metadata", () => {
    expect(isTaskNotice(notice)).toBe(true);
    expect(isTaskNotice({ kind: "delegation-report", tasks: [] })).toBe(false);
    expect(isTaskNotice(null)).toBe(false);
  });

  it("counts delegation reports and task notices as the platform writing, not the user", () => {
    expect(isPlatformNotice(notice)).toBe(true);
    expect(isPlatformNotice({ kind: "delegation-report", tasks: [] })).toBe(true);
    expect(isPlatformNotice({ kind: "compaction" })).toBe(false);
    expect(isPlatformNotice(undefined)).toBe(false);
  });
});

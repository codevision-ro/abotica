import { afterEach, describe, expect, it, vi } from "vitest";

/** tasks.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./tasks");
}

afterEach(() => vi.unstubAllEnvs());

describe("isActiveTaskRunConflict", () => {
  it("recognizes the task's unique index, also when wrapped", async () => {
    const { isActiveTaskRunConflict } = await load();
    const pg = { code: "23505", constraint_name: "runs_one_active_per_task" };
    expect(isActiveTaskRunConflict(pg)).toBe(true);
    expect(isActiveTaskRunConflict(new Error("Failed query", { cause: pg }))).toBe(true);
  });

  it("recognizes the error startRun raises for it", async () => {
    const { isActiveTaskRunConflict, TaskBusyError } = await load();
    expect(isActiveTaskRunConflict(new TaskBusyError("t1"))).toBe(true);
  });

  it("ignores other errors", async () => {
    const { isActiveTaskRunConflict } = await load();
    expect(isActiveTaskRunConflict({ code: "23505", constraint_name: "runs_one_active_per_conversation" })).toBe(false);
    expect(isActiveTaskRunConflict(new Error("boom"))).toBe(false);
    expect(isActiveTaskRunConflict(undefined)).toBe(false);
  });
});

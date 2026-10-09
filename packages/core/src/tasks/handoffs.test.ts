import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitUntrusted } from "../agents/untrusted";
import type { SentQuery } from "./test-queries";

/** Handoffs between dependent tasks, with the queries intercepted (test-queries.ts) and files and delivery mocked. */

const state = vi.hoisted(() => {
  // The schema's client needs a URL; nothing connects.
  process.env.DATABASE_URL ??= "postgres://test@localhost/test";
  return { sent: [] as SentQuery[], routes: [] as [RegExp, unknown[]][] };
});

vi.mock("@abotica/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@abotica/db")>();
  const { interceptQueries } = await import("./test-queries");
  interceptQueries(actual.db, actual.tasks, (q) => {
    state.sent.push(q);
    return state.routes.find(([re]) => re.test(q.sql))?.[1] ?? [];
  });
  return actual;
});
vi.mock("../files/files", () => ({
  deleteFile: vi.fn(async () => null),
  readFileBytes: vi.fn(async (id: string) => (id === "gone" ? null : new TextEncoder().encode(`bytes of ${id}`))),
  saveFile: vi.fn(async () => ({})),
}));
vi.mock("../runs/deliver", () => ({ deliverToSuperior: vi.fn(async () => ({ result: "woke" })) }));

const { deleteFile, saveFile } = await import("../files/files");
const { deliverToSuperior } = await import("../runs/deliver");
const { alertDependents, dependencyAlertText, handOffFiles } = await import("./handoffs");

const answer = (sql: RegExp, rows: unknown[]) => state.routes.push([sql, rows]);
const sentLike = (sql: RegExp) => state.sent.filter((q) => sql.test(q.sql));
const events = (type: string) => sentLike(/^insert into "task_events"/).filter((q) => q.params.includes(type));

beforeEach(() => {
  state.sent.length = 0;
  state.routes.length = 0;
  vi.clearAllMocks();
});

const file = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  file: { id, name, mimeType: "text/csv", size: 10, runId: "r1", agentId: "a1", taskId: "t1", ...over },
  agentId: "a1",
});

describe("handOffFiles", () => {
  const DEPENDENTS = /^select "tasks"."id" from "task_dependencies"/;
  const PRODUCED = /^select .* from "files" inner join "runs"/;
  const EARLIER = /^select "id", "name" from "files"/;

  it("copies nothing when no open task depends on the done one", async () => {
    expect(await handOffFiles("t1")).toBe(0);
    expect(sentLike(DEPENDENTS)[0]!.sql).toContain('"tasks"."status" not in');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("copies the latest version of each produced file to every dependent, as handed over by its producer", async () => {
    answer(DEPENDENTS, [{ id: "t2" }, { id: "t3" }]);
    answer(PRODUCED, [
      file("f1", "data.csv"),
      file("f2", "notes.md", { runId: "r2" }),
      file("f3", "data.csv", { runId: "r2" }),
    ]);

    expect(await handOffFiles("t1")).toBe(4);
    expect(sentLike(PRODUCED)[0]!.sql).toContain('"runs"."id" = "files"."run_id" and "runs"."task_id" = "files"."task_id"');
    expect(vi.mocked(saveFile).mock.calls.map(([input]) => [input.owner, input.name, input.runId])).toEqual([
      [{ taskId: "t2" }, "data.csv", "r2"],
      [{ taskId: "t2" }, "notes.md", "r2"],
      [{ taskId: "t3" }, "data.csv", "r2"],
      [{ taskId: "t3" }, "notes.md", "r2"],
    ]);
    expect(saveFile).toHaveBeenCalledWith({
      name: "data.csv",
      data: new TextEncoder().encode("bytes of f3"),
      source: "agent",
      owner: { taskId: "t2" },
      mimeType: "text/csv",
      runId: "r2",
      agentId: "a1",
    });
    expect(events("handoff").map((q) => q.params[0])).toEqual(["t2", "t3"]);
  });

  it("replaces an earlier copy of the same name from the same task", async () => {
    answer(DEPENDENTS, [{ id: "t2" }]);
    answer(PRODUCED, [file("f1", "data.csv")]);
    answer(EARLIER, [{ id: "old", name: "data.csv" }]);

    await handOffFiles("t1");
    expect(sentLike(EARLIER)[0]!.sql).toContain('"files"."run_id" in (select "id" from "runs" where "runs"."task_id" = $');
    expect(deleteFile).toHaveBeenCalledExactlyOnceWith("old");
  });

  it("skips files too large to copy and bytes gone from the disk", async () => {
    answer(DEPENDENTS, [{ id: "t2" }]);
    answer(PRODUCED, [file("big", "video.mp4", { size: 60 * 1024 * 1024 }), file("gone", "lost.txt")]);

    expect(await handOffFiles("t1")).toBe(0);
    expect(saveFile).not.toHaveBeenCalled();
    expect(events("handoff")).toEqual([]);
  });
});

describe("alertDependents", () => {
  const DEPENDENCY = /^select .* from "tasks" where "tasks"."id" = \$1$/;
  const WAITING = /^select "tasks"."id", "tasks"."title" from "task_dependencies"/;
  const ALERTED = /^select "task_id" from "task_events"/;
  const CONVERSATIONS = /^select "tasks"."id", "runs"."conversation_id" from "tasks"/;
  const COMMENT = /^select "body" from "task_comments"/;

  const setup = (conversations: { id: string; conversationId: string }[]) => {
    answer(DEPENDENCY, [{ id: "t1", title: "Collect the data" }]);
    answer(WAITING, [
      { id: "t2", title: "Chart it" },
      { id: "t3", title: "Write it up" },
    ]);
    answer(CONVERSATIONS, conversations);
    answer(COMMENT, [{ body: "No access to the shop's database." }]);
  };

  it("does nothing for a status that does not stop its dependents", async () => {
    await alertDependents("t1", "review");
    expect(state.sent).toEqual([]);
  });

  it("alerts each other delegator once, naming the tasks that cannot start and why", async () => {
    setup([
      { id: "t1", conversationId: "c-manager" },
      { id: "t2", conversationId: "c-super" },
      { id: "t3", conversationId: "c-super" },
    ]);
    await alertDependents("t1", "blocked");

    expect(sentLike(WAITING)[0]!.sql).toContain('"tasks"."status" = $');
    expect(deliverToSuperior).toHaveBeenCalledExactlyOnceWith(
      "t2",
      {
        kind: "alert",
        text: expect.stringContaining('Tasks "Chart it" (t2), "Write it up" (t3) cannot start'),
        from: "Abotica",
      },
      { wake: "now" },
    );
    const text = vi.mocked(deliverToSuperior).mock.calls[0]![1].text;
    expect(splitUntrusted(text).filter((s) => s.type === "untrusted")).toEqual([
      { type: "untrusted", source: "delegated-task", text: "No access to the shop's database." },
    ]);
    expect(events("dependency-alert").map((q) => q.params[0])).toEqual(["t2", "t3"]);
  });

  it("leaves dependents delegated from the dependency's own conversation to its report", async () => {
    setup([
      { id: "t1", conversationId: "c-manager" },
      { id: "t2", conversationId: "c-manager" },
      { id: "t3", conversationId: "c-manager" },
    ]);
    await alertDependents("t1", "cancelled");

    expect(deliverToSuperior).not.toHaveBeenCalled();
    expect(events("dependency-alert")).toHaveLength(2);
  });

  it("alerts about each dependent, dependency and status only once", async () => {
    setup([
      { id: "t1", conversationId: "c-manager" },
      { id: "t2", conversationId: "c-super" },
      { id: "t3", conversationId: "c-super" },
    ]);
    answer(ALERTED, [{ taskId: "t2" }]);
    await alertDependents("t1", "blocked");

    const [dedupe] = sentLike(ALERTED);
    expect(dedupe!.sql).toContain(`"task_events"."data"->>'dependencyId' = $`);
    expect(dedupe!.params).toEqual(expect.arrayContaining(["dependency-alert", "t1", "blocked"]));
    expect(deliverToSuperior).toHaveBeenCalledExactlyOnceWith(
      "t3",
      expect.objectContaining({ text: expect.stringContaining('Task "Write it up" (t3) cannot start') }),
      { wake: "now" },
    );
  });
});

describe("dependencyAlertText", () => {
  it("gives the choices for a cancelled dependency", () => {
    const text = dependencyAlertText({ id: "t1", title: "Collect" }, "cancelled", null, [{ id: "t2", title: "Chart" }]);
    expect(text).toBe(
      'Task "Chart" (t2) cannot start: it waits on "Collect" (t1), which is cancelled.\n\nDecide now: remove the dependency so the work can start without it, have the cancelled part done another way, or cancel the waiting work (task_control).',
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationHistory } from "../runs/run-messages";

/**
 * The writes of the memory a run gets: the recall saved on a message, and the use of the entries in the
 * instructions. The database is a fake built on the real query builder, so the SQL can be read.
 */

const state = vi.hoisted(() => {
  // The schema's client needs a URL; nothing connects.
  process.env.DATABASE_URL ??= "postgres://test@localhost/test";
  return {
    /** The SQL of each update. */
    updates: [] as string[],
    /** What the sum of the tokens of the memory a run may read comes to (allFit). */
    memoryTokens: 0,
    /** An update that fails, as with the database down. */
    failing: false,
  };
});

vi.mock("@abotica/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@abotica/db")>();
  const update = (table: Parameters<typeof actual.db.update>[0]) => ({
    set: (patch: Parameters<ReturnType<typeof actual.db.update>["set"]>[0]) => ({
      where: (where: Parameters<ReturnType<ReturnType<typeof actual.db.update>["set"]>["where"]>[0]) => {
        state.updates.push(actual.db.update(table).set(patch).where(where).toSQL().sql);
        return state.failing ? Promise.reject(new Error("database down")) : Promise.resolve();
      },
    }),
  });
  return {
    ...actual,
    db: {
      update,
      select: () => ({ from: () => ({ where: async () => [{ tokens: state.memoryTokens }] }) }),
      transaction: async (work: (tx: unknown) => Promise<void>) => work({ update }),
    },
  };
});

const { notePromptMemoryUse, recallForRun } = await import("./memory-recall");

beforeEach(() => {
  state.updates.length = 0;
  state.memoryTokens = 0;
  state.failing = false;
});

afterEach(() => vi.restoreAllMocks());

describe("recallForRun", () => {
  const history: ConversationHistory = {
    compaction: null,
    messages: [
      {
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "Where do deploys go?" }] },
        createdAt: new Date(),
      },
    ],
  };
  const run = (memoryRecallTokens: number) => ({
    id: "r1",
    input: "Where do deploys go?",
    agentId: "a1",
    projectId: null,
    settings: { memory: { pinnedTokens: 2000, recallTokens: memoryRecallTokens } },
  });
  const empty = { memoryIds: [], text: "" };

  it.each([
    ["recall is off", 0],
    ["all memory fits in the instructions", 1000],
  ])("saves an empty recall when %s, so a continuation never adds one to the turn", async (_case, recallTokens) => {
    state.memoryTokens = 500;
    const recalled = await recallForRun(history, run(recallTokens));
    expect(recalled.messages[0]!.message.metadata).toEqual({ recall: empty });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatch(/^update "messages" set "metadata" = /);
  });
});

describe("notePromptMemoryUse", () => {
  it("counts a use at most once a day an entry, and keeps updatedAt", async () => {
    notePromptMemoryUse(["m1", "m2"]);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));
    const sql = state.updates[0]!;
    expect(sql).toContain('"recall_count" = "memories"."recall_count" + 1');
    expect(sql).toContain('"last_recalled_at" = now()');
    expect(sql).toContain('"updated_at" = "memories"."updated_at"');
    expect(sql).toContain(
      '("memories"."last_recalled_at" is null or "memories"."last_recalled_at" < now() - interval \'1 day\')',
    );
  });

  it("writes nothing without entries", () => {
    notePromptMemoryUse([]);
    expect(state.updates).toEqual([]);
  });

  it("logs a failed write instead of failing the run", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    state.failing = true;
    expect(() => notePromptMemoryUse(["m1"])).not.toThrow();
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining("[memory]"), expect.any(Error)));
  });
});

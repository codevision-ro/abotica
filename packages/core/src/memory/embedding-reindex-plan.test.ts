import { describe, expect, it } from "vitest";
import { advanceReindex, type ReindexState, rowsToEmbed, sameBatch, startReindex } from "./embedding-reindex-plan";

const start = startReindex("ollama", 250, new Date("2026-10-08T10:00:00Z"));

describe("startReindex", () => {
  it("starts before the first row of the first table", () => {
    expect(start).toEqual({
      provider: "ollama",
      startedAt: "2026-10-08T10:00:00.000Z",
      table: "memories",
      after: null,
      done: 0,
      total: 250,
      error: null,
    });
  });
});

describe("advanceReindex", () => {
  it("stays in the table after a full batch, from its last id", () => {
    expect(advanceReindex(start, ["a", "b", "c"], 3)).toMatchObject({ table: "memories", after: "c", done: 3 });
  });

  it("moves to the next table after a short batch", () => {
    const state: ReindexState = { ...start, after: "c", done: 3 };
    expect(advanceReindex(state, ["d"], 3)).toMatchObject({ table: "journals", after: null, done: 4 });
    expect(advanceReindex({ ...state, table: "journals" }, [], 3)).toMatchObject({ table: "knowledge_chunks", done: 3 });
  });

  it("ends after a short batch of the last table", () => {
    expect(advanceReindex({ ...start, table: "knowledge_chunks" }, ["x"], 3)).toBeNull();
  });

  it("clears the error once a batch goes through", () => {
    expect(advanceReindex({ ...start, error: "connection refused" }, ["a"], 3)?.error).toBeNull();
  });
});

describe("sameBatch", () => {
  it("matches only the same re-embedding at the same place", () => {
    expect(sameBatch({ ...start, done: 9, error: "x" }, start)).toBe(true);
    expect(sameBatch({ ...start, after: "c" }, start)).toBe(false);
    expect(sameBatch({ ...start, table: "journals" }, start)).toBe(false);
    expect(sameBatch({ ...start, provider: "openai" }, start)).toBe(false);
    // Switched away and back: a new re-embedding, even at the same place.
    expect(sameBatch({ ...start, startedAt: "2026-10-08T10:05:00.000Z" }, start)).toBe(false);
  });
});

describe("rowsToEmbed", () => {
  const allows = (projectId: string) => projectId !== "closed";

  it("embeds rows without an embedding, outside projects or in a project that allows the provider", () => {
    const rows = [
      { id: "1", projectId: null, embedded: false },
      { id: "2", projectId: "open", embedded: false },
      { id: "3", projectId: "closed", embedded: false },
      { id: "4", projectId: null, embedded: true },
    ];
    expect(rowsToEmbed(rows, allows).map((r) => r.id)).toEqual(["1", "2"]);
  });
});

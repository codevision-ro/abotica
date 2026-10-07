import { describe, expect, it } from "vitest";
import { isCompaction, placeCompactions } from "./compaction-record";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 9, minute));
const message = (id: string, minute: number) => ({ id, metadata: null, createdAt: at(minute) });
const compaction = (id: string, minute: number, coversUntil: number) => ({
  id,
  metadata: { kind: "compaction", coversUntil: at(coversUntil).toISOString() },
  createdAt: at(minute),
});

describe("placeCompactions", () => {
  it("puts a compaction right after the last message it covers, not where it was made", () => {
    const rows = [message("u1", 0), message("a1", 1), message("u2", 2), message("a2", 3), compaction("c1", 4, 1)];
    expect(placeCompactions(rows).map((r) => r.id)).toEqual(["u1", "a1", "c1", "u2", "a2"]);
  });

  it("keeps compactions of the same messages in the order they were made", () => {
    const rows = [message("u1", 0), message("a1", 1), compaction("c1", 2, 1), message("u2", 3), compaction("c2", 4, 1)];
    expect(placeCompactions(rows).map((r) => r.id)).toEqual(["u1", "a1", "c1", "c2", "u2"]);
  });

  it("leaves a conversation without compactions as it is", () => {
    const rows = [message("u1", 0), message("a1", 1)];
    expect(placeCompactions(rows)).toEqual(rows);
  });
});

describe("isCompaction", () => {
  it("recognizes a compaction's metadata only", () => {
    expect(isCompaction({ kind: "compaction" })).toBe(true);
    expect(isCompaction({ kind: "delegation-report" })).toBe(false);
    expect(isCompaction(null)).toBe(false);
  });
});

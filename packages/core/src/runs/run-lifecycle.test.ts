import { beforeAll, describe, expect, it, vi } from "vitest";
import type { staleRunReason as StaleRunReason } from "./run-lifecycle";

let staleRunReason: typeof StaleRunReason;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  ({ staleRunReason } = await import("./run-lifecycle"));
});

const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const TIMEOUT = 10 * 60_000;
const MINUTE = 60_000;

describe("staleRunReason", () => {
  it("leaves a fresh queued run alone, even before its job exists", () => {
    expect(staleRunReason({ status: "queued", createdAt: ago(5_000), startedAt: null }, "unknown", TIMEOUT, NOW)).toBe(
      null,
    );
  });

  it("leaves a queued run whose job is still going to be picked up", () => {
    for (const job of ["waiting", "prioritized", "delayed", "waiting-children", "active"] as const) {
      expect(staleRunReason({ status: "queued", createdAt: ago(30 * MINUTE), startedAt: null }, job, TIMEOUT, NOW)).toBe(
        null,
      );
    }
  });

  it("flags a queued run whose job is gone or ended", () => {
    for (const job of ["unknown", "completed", "failed"] as const) {
      expect(staleRunReason({ status: "queued", createdAt: ago(2 * MINUTE), startedAt: null }, job, TIMEOUT, NOW)).toBe(
        "unqueued",
      );
    }
  });

  it("flags a running run without an active job: its worker is gone", () => {
    for (const job of ["unknown", "completed", "failed", "waiting"] as const) {
      expect(staleRunReason({ status: "running", createdAt: ago(MINUTE), startedAt: ago(MINUTE) }, job, TIMEOUT, NOW)).toBe(
        "orphaned",
      );
    }
  });

  it("leaves a running run an active job owns until its timeout plus the margin", () => {
    const run = (startedMsAgo: number) => ({
      status: "running" as const,
      createdAt: ago(startedMsAgo),
      startedAt: ago(startedMsAgo),
    });
    expect(staleRunReason(run(TIMEOUT + 14 * MINUTE), "active", TIMEOUT, NOW)).toBe(null);
    expect(staleRunReason(run(TIMEOUT + 16 * MINUTE), "active", TIMEOUT, NOW)).toBe("overdue");
  });

  it("never touches runs that already ended or wait for approvals", () => {
    for (const status of ["succeeded", "failed", "cancelled", "waiting_approval"] as const) {
      expect(
        staleRunReason({ status, createdAt: ago(60 * MINUTE), startedAt: ago(60 * MINUTE) }, "unknown", TIMEOUT, NOW),
      ).toBe(null);
    }
  });
});

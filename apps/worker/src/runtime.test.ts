import { executeRun } from "@abotica/core/agents/runner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activeRunCount, drainRuns, startRunsWorker } from "./runtime";

type Processor = (job: { data: { runId: string } }) => Promise<void>;
const bullmq = vi.hoisted(() => ({ processor: null as Processor | null }));

// The runs worker with its job processor captured; a run that returns null touches nothing else.
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_queue: string, processor: Processor) {
      bullmq.processor = processor;
    }
  },
}));
vi.mock("@abotica/core", () => ({
  createRedis: () => ({}),
  QUEUE: { runs: "runs" },
  RunAbort: class extends Error {
    constructor(
      message: string,
      readonly kind: string,
    ) {
      super(message);
    }
  },
  startFollowUpIfQueued: vi.fn(),
}));
vi.mock("@abotica/core/agents/runner", () => ({ executeRun: vi.fn() }));
vi.mock("@abotica/db", () => ({ conversations: {}, db: {}, runs: {} }));
vi.mock("@abotica/db/orm", () => ({ eq: vi.fn() }));
vi.mock("./telegram/delivery", () => ({ deliverTelegramReply: vi.fn(), showTelegramTyping: vi.fn() }));

const REASON = "Stopped because the worker is restarting";

/** A run executing in the worker until finish() is called or it is aborted. */
function startRun(runId: string) {
  let finish = () => {};
  let abortedWith: string | undefined;
  let abortKind: string | undefined;
  vi.mocked(executeRun).mockImplementationOnce(async (_runId, signal) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener("abort", () => {
        abortedWith = (signal.reason as Error).message;
        abortKind = (signal.reason as { kind?: string }).kind;
        resolve();
      });
    });
    return null;
  });
  const ended = bullmq.processor!({ data: { runId } });
  return { finish: () => finish(), ended, abortedWith: () => abortedWith, abortKind: () => abortKind };
}

beforeAll(() => {
  startRunsWorker(4);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("drainRuns", () => {
  it("returns at once when no run is executing", async () => {
    const reason = vi.fn(async () => REASON);
    await expect(drainRuns(30_000, reason)).resolves.toBe(0);
    expect(reason).not.toHaveBeenCalled();
  });

  it("lets a run that ends within the window finish on its own", async () => {
    const run = startRun("r1");
    expect(activeRunCount()).toBe(1);
    const reason = vi.fn(async () => REASON);
    const drained = drainRuns(30_000, reason);
    run.finish();
    await expect(drained).resolves.toBe(0);
    await run.ended;
    expect(run.abortedWith()).toBeUndefined();
    expect(reason).not.toHaveBeenCalled();
    expect(activeRunCount()).toBe(0);
  });

  it("aborts the runs still going when the window ends, then waits for them to end", async () => {
    vi.useFakeTimers();
    const quick = startRun("r2");
    const slow = [startRun("r3"), startRun("r4")];
    const drained = drainRuns(1_000, async () => REASON);
    quick.finish();
    await vi.advanceTimersByTimeAsync(999);
    expect(slow.map((r) => r.abortedWith())).toEqual([undefined, undefined]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(drained).resolves.toBe(2);
    expect(quick.abortedWith()).toBeUndefined();
    expect(slow.map((r) => r.abortedWith())).toEqual([REASON, REASON]);
    // The runner records them as cut by the restart, which the task's circuit breaker does not count.
    expect(slow.map((r) => r.abortKind())).toEqual(["worker_restarted", "worker_restarted"]);
    expect(activeRunCount()).toBe(0);
  });

  it("aborts right away with no window", async () => {
    const run = startRun("r5");
    await expect(drainRuns(0, async () => REASON)).resolves.toBe(1);
    expect(run.abortedWith()).toBe(REASON);
  });
});

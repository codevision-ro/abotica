import type { UIMessageChunk } from "ai";
import { createRedis, redis } from "../infra/redis";

/**
 * Runs execute in the worker; the web chat reads their UI message chunks from a Redis stream.
 * Readers can attach at any time and replay from the beginning, so reloads resume cleanly.
 */
const key = (runId: string) => `abotica:run:${runId}:ui`;
const END = "__end__";
const TTL_SECONDS = 3600;

/**
 * Never rejects: streaming is a live view, the answer is saved with the conversation anyway. After a
 * failed write the run goes on without streaming, and the chat shows the answer once it is saved.
 */
export function createRunStreamWriter(runId: string) {
  const k = key(runId);
  let pending: Promise<void> = Promise.resolve();
  let started = false;
  let broken = false;
  const enqueue = (fields: string[], refreshTtl = false) => {
    pending = pending.then(async () => {
      if (broken) return;
      try {
        await redis().xadd(k, "*", ...fields);
        // Set with the first chunk, so the stream of a run that never ends expires too.
        if (!started || refreshTtl) await redis().expire(k, TTL_SECONDS);
        started = true;
      } catch (error) {
        broken = true;
        console.error(`[runs] streaming run ${runId} failed, it continues without streaming:`, error);
      }
    });
    return pending;
  };
  return {
    write: (chunk: UIMessageChunk) => enqueue(["c", JSON.stringify(chunk)]),
    end: () => enqueue(["c", END], true),
  };
}

/** Async iterator over a run's chunks; ends at the end marker, on abort, or after idleMs of silence. */
export async function* readRunStream(
  runId: string,
  { signal, idleMs = 120_000 }: { signal?: AbortSignal; idleMs?: number } = {},
): AsyncGenerator<UIMessageChunk> {
  const conn = createRedis();
  const k = key(runId);
  let lastId = "0";
  let idleSince = Date.now();
  try {
    while (!signal?.aborted) {
      const res = (await conn.xread("BLOCK", 5_000, "STREAMS", k, lastId)) as [string, [string, string[]][]][] | null;
      if (!res) {
        if (Date.now() - idleSince > idleMs) return;
        continue;
      }
      idleSince = Date.now();
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          lastId = id;
          const value = fields[1];
          if (value === END) return;
          if (value) yield JSON.parse(value) as UIMessageChunk;
        }
      }
    }
  } finally {
    conn.disconnect();
  }
}

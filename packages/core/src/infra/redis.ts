import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { env } from "./env";

const globalForRedis = globalThis as unknown as { aboticaRedis?: Redis };

/** Shared connection for commands. BullMQ workers and subscribers need their own. */
export function redis(): Redis {
  globalForRedis.aboticaRedis ??= createRedis();
  return globalForRedis.aboticaRedis;
}

export function createRedis(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * Runs `fn` holding a lock shared by the web app and the workers, waiting up to `ttlMs` to get it. The
 * lock expires after `ttlMs` should its holder die, and only its holder releases it.
 */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; pollMs?: number } = {},
): Promise<T> {
  const { ttlMs = 30_000, pollMs = 100 } = opts;
  const owner = randomUUID();
  const deadline = Date.now() + ttlMs;
  while (!(await redis().set(key, owner, "PX", ttlMs, "NX"))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock ${key}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  try {
    return await fn();
  } finally {
    // A lock that expired meanwhile may belong to another process now.
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      key,
      owner,
    );
  }
}

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

const LOCK_TTL_MS = 30_000;
const LOCK_POLL_MS = 100;

/**
 * Runs `fn` holding a lock shared by the web app and the workers, waiting up to LOCK_TTL_MS to get it.
 * The lock expires after LOCK_TTL_MS should its holder die, and only its holder releases it.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_TTL_MS;
  while (!(await redis().set(key, owner, "PX", LOCK_TTL_MS, "NX"))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock ${key}`);
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
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

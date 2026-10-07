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

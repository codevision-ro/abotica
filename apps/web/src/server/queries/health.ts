import "server-only";
import { redis } from "@abotica/core";
import { db } from "@abotica/db";
import { sql } from "@abotica/db/orm";
import { publicQuery } from "@/server/query";

/** Longest wait for each dependency: a hung one fails the probe instead of hanging it past the monitor's own timeout. */
const CHECK_TIMEOUT_MS = 3_000;

async function reachable(check: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      check.then(
        () => true,
        () => false,
      ),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the database and Redis answer. No session check: the public health route calls it, and it reveals only up/down. */
export const getHealth = publicQuery(async () => {
  const [database, cache] = await Promise.all([reachable(db.execute(sql`select 1`)), reachable(redis().ping())]);
  return { database, redis: cache };
});

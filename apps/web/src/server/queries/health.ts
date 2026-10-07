import "server-only";
import { redis } from "@abotica/core";
import { db } from "@abotica/db";
import { sql } from "@abotica/db/orm";
import { publicQuery } from "@/server/query";

const reachable = (check: Promise<unknown>) =>
  check.then(
    () => true,
    () => false,
  );

/** Whether the database and Redis answer. No session check: the public health route calls it, and it reveals only up/down. */
export const getHealth = publicQuery(async () => {
  const [database, cache] = await Promise.all([reachable(db.execute(sql`select 1`)), reachable(redis().ping())]);
  return { database, redis: cache };
});

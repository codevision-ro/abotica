import { db, runs } from "@abotica/db";
import { and, eq, gte, inArray, isNotNull, or, sql } from "@abotica/db/orm";
import { MODEL_FAILURE_KINDS, type ModelRunStats, RATING_WINDOW_DAYS } from "./model-ratings";

type ModelStatsRow = ModelRunStats & { provider: string; model: string };

/**
 * What each model did in the runs that finished in the rating window, for rateModel. Every model that
 * finished a run is listed, even when none of its runs counts (all hit a rate limit, say).
 */
export async function modelRunStats(): Promise<ModelStatsRow[]> {
  const since = new Date(Date.now() - RATING_WINDOW_DAYS * 86_400_000);
  const succeeded = eq(runs.status, "succeeded");
  const failed = and(eq(runs.status, "failed"), inArray(runs.failureKind, [...MODEL_FAILURE_KINDS]));
  const counted = or(succeeded, failed);
  const tokens = sql`${runs.inputTokens} + ${runs.outputTokens}`;
  const rows = await db
    .select({
      provider: runs.provider,
      model: runs.model,
      succeeded: sql<number>`count(*) filter (where ${succeeded})`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${failed})`.mapWith(Number),
      tokens: sql<number>`coalesce(sum(${tokens}) filter (where ${counted}), 0)`.mapWith(Number),
    })
    .from(runs)
    .where(and(gte(runs.finishedAt, since), isNotNull(runs.provider), isNotNull(runs.model)))
    .groupBy(runs.provider, runs.model);
  return rows.map((r) => ({ ...r, provider: r.provider!, model: r.model! }));
}

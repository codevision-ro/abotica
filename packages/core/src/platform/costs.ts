import { db, runs } from "@abotica/db";
import { and, gte, lt, sum } from "@abotica/db/orm";

/** Milliseconds the timezone's wall clock is ahead of UTC at a given moment. */
function offsetMs(timezone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of local midnight for a YYYY-MM-DD day; the offset is taken near that midnight so DST days work. */
function localMidnight(timezone: string, day: string): Date {
  const utcMidnight = new Date(`${day}T00:00:00Z`).getTime();
  const guess = utcMidnight - offsetMs(timezone, new Date(utcMidnight));
  return new Date(utcMidnight - offsetMs(timezone, new Date(guess)));
}

/** Calendar day (YYYY-MM-DD) containing `date` in the timezone, and its UTC bounds [start, end). */
export function dayBounds(timezone: string, date: Date = new Date()): { day: string; start: Date; end: Date } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    day,
    start: localMidnight(timezone, day),
    end: localMidnight(timezone, next.toISOString().slice(0, 10)),
  };
}

/** UTC instant of local midnight on the first of the current month in the timezone, or `offset` months away. */
export function startOfMonth(timezone: string, offset = 0): Date {
  const first = new Date(`${dayBounds(timezone).day.slice(0, 7)}-01T12:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + offset);
  return localMidnight(timezone, first.toISOString().slice(0, 10));
}

/** Total cost (USD) of the runs created since `since`, up to `until` when given. */
export async function costSince(since: Date, until?: Date): Promise<number> {
  const [row] = await db
    .select({ total: sum(runs.costUsd) })
    .from(runs)
    .where(until ? and(gte(runs.createdAt, since), lt(runs.createdAt, until)) : gte(runs.createdAt, since));
  return Number(row?.total ?? 0);
}

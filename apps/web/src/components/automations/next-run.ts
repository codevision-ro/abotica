import { isValidCron } from "@abotica/core/cron";
import { isTimeZone, wallParts, zonedLocalToDate } from "@/lib/time-zone";

const pad = (n: number) => String(n).padStart(2, "0");

/** Values a cron field allows: numbers, ranges, lists and steps (same syntax as `isValidCron`). */
function fieldValues(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range = "*", stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let [from, to] = range === "*" ? [min, max] : range.split("-").map(Number);
    from ??= min;
    // "5/15" runs from 5 to the end of the range, like "5-59/15".
    to ??= stepText ? max : from;
    for (let v = from; v <= to; v += Math.max(step, 1)) values.add(v);
  }
  return values;
}

/**
 * Next time a schedule fires after `from`, or null when it never will (invalid, or a one-off in the past).
 * Cron times are wall-clock times in the schedule's time zone; when both day fields are restricted,
 * either one matching is enough, as in standard cron.
 */
export function nextRun(
  schedule: { kind: "cron" | "once"; cron: string | null; runAt: Date | string | null; timezone: string },
  from: Date,
): Date | null {
  if (schedule.kind === "once") {
    const at = schedule.runAt ? new Date(schedule.runAt) : null;
    return at && at > from ? at : null;
  }
  const cron = schedule.cron?.trim() ?? "";
  if (!isValidCron(cron) || !isTimeZone(schedule.timezone)) return null;
  const [minF, hourF, domF, monF, dowF] = cron.split(/\s+/) as [string, string, string, string, string];
  const minutes = [...fieldValues(minF, 0, 59)].sort((a, b) => a - b);
  const hours = [...fieldValues(hourF, 0, 23)].sort((a, b) => a - b);
  const doms = fieldValues(domF, 1, 31);
  const months = fieldValues(monF, 1, 12);
  const dows = new Set([...fieldValues(dowF, 0, 7)].map((d) => d % 7));
  const domAny = domF === "*";
  const dowAny = dowF === "*";

  const now = wallParts(from, schedule.timezone);
  // Five years covers every valid pattern, including 29 February.
  for (let i = 0; i < 366 * 5; i++) {
    const day = new Date(Date.UTC(now.y, now.m - 1, now.d + i));
    if (!months.has(day.getUTCMonth() + 1)) continue;
    const domOk = doms.has(day.getUTCDate());
    const dowOk = dows.has(day.getUTCDay());
    if (!(domAny || dowAny ? domOk && dowOk : domOk || dowOk)) continue;
    const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    for (const h of hours) {
      for (const min of minutes) {
        if (i === 0 && (h < now.h || (h === now.h && min <= now.min))) continue;
        const at = zonedLocalToDate(`${date}T${pad(h)}:${pad(min)}`, schedule.timezone);
        if (at > from) return at;
      }
    }
  }
  return null;
}

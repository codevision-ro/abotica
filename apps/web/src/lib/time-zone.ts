const pad = (n: number) => String(n).padStart(2, "0");

export function wallParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = wallParts(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-10-05T09:00" as wall time in `timeZone` to an absolute Date. */
export function zonedLocalToDate(local: string, timeZone: string): Date {
  const asUtc = Date.parse(`${local}:00Z`);
  let ts = asUtc - offsetMs(new Date(asUtc), timeZone);
  ts = asUtc - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Absolute Date to a datetime-local value as seen in `timeZone`. */
export function dateToZonedLocal(date: Date | string, timeZone: string): string {
  const p = wallParts(new Date(date), timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

export function formatInZone(date: Date | string, timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

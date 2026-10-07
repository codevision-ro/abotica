import { isValidCron } from "@abotica/core/cron";
import type { useTranslations } from "next-intl";

/** Translator for the "automations.cron" namespace (from useTranslations("automations.cron")). */
export type CronTranslator = ReturnType<typeof useTranslations<"automations.cron">>;

/** Labels come from automations.cron.presets.<key>. */
export const CRON_PRESETS = [
  { key: "daily9", cron: "0 9 * * *" },
  { key: "weekdays9", cron: "0 9 * * 1-5" },
  { key: "monday9", cron: "0 9 * * 1" },
  { key: "hourly", cron: "0 * * * *" },
] as const;

const pad = (n: string) => n.padStart(2, "0");
const isNum = (v: string) => /^\d{1,2}$/.test(v);
const capitalize = (s: string, locale: string) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

/** Weekday name in `locale`; cron day 0 and 7 are Sunday. */
function dayName(day: number, locale: string): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2023, 0, 1 + (day % 7))),
  );
}

function listDays(dow: string, locale: string): string | null {
  const names: string[] = [];
  for (const part of dow.split(",")) {
    if (isNum(part)) names.push(Number(part) <= 7 ? dayName(Number(part), locale) : part);
    else if (/^\d-\d$/.test(part)) {
      const [a, b] = part.split("-").map(Number) as [number, number];
      names.push(`${dayName(a, locale)}-${dayName(b, locale)}`);
    } else return null;
  }
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}

/** Human-readable description for common patterns in the current language; falls back to the raw cron. */
export function describeCron(value: string | null | undefined, t: CronTranslator, locale: string): string {
  if (!value) return "";
  const cron = value.trim();
  if (!isValidCron(cron)) return cron;
  const [min, hour, dom, mon, dow] = cron.split(/\s+/) as [string, string, string, string, string];
  const time = isNum(min) && isNum(hour) ? `${pad(hour)}:${pad(min)}` : null;

  if (cron === "* * * * *") return t("everyMinute");
  if (dom === "*" && mon === "*" && dow === "*") {
    if (/^\*\/\d+$/.test(min) && hour === "*") return t("everyNMinutes", { n: Number(min.slice(2)) });
    if (isNum(min) && hour === "*") return min === "0" ? t("hourlyOnTheHour") : t("hourlyAtMinute", { min });
    if (isNum(min) && /^\*\/\d+$/.test(hour)) return t("everyNHours", { n: Number(hour.slice(2)), min });
    if (time) return t("daily", { time });
  }
  if (time && dom === "*" && mon === "*") {
    if (dow === "1-5") return t("weekdays", { time });
    if (dow === "0,6" || dow === "6,0") return t("weekend", { time });
    const days = listDays(dow, locale);
    if (days) {
      const text = dow.includes(",") || dow.includes("-") ? t("days", { days, time }) : t("everyDay", { day: days, time });
      return capitalize(text, locale);
    }
  }
  if (time && isNum(dom) && mon === "*" && dow === "*") return t("monthly", { day: dom, time });
  return cron;
}

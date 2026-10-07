import type { Locale } from "@abotica/i18n";
import { format, formatDistanceToNowStrict, type Locale as DateFnsLocale } from "date-fns";
import { enUS, ro } from "date-fns/locale";

const DATE_FNS_LOCALES: Record<Locale, DateFnsLocale> = { en: enUS, ro };

type DateInput = Date | string | null | undefined;

/**
 * Locale-bound formatters. Use useFormat() in client components and getFormat() on the server
 * rather than calling this directly.
 */
export function createFormat(locale: Locale) {
  const dateLocale = DATE_FNS_LOCALES[locale];
  return {
    usd(value: number | null | undefined): string {
      const v = Number(value ?? 0);
      return `$${v.toFixed(v !== 0 && Math.abs(v) < 1 ? 4 : 2)}`;
    },
    /** List price per 1M tokens, always two decimals ($0.60, not $0.6). */
    modelPrice(value: number): string {
      return `$${value.toFixed(2)}`;
    },
    /** Binary units (1 KB = 1024 B). */
    fileSize(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    },
    tokens(value: number | null | undefined): string {
      return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0);
    },
    /** "5 minutes ago" / "5 minute în urmă" (date-fns wording). */
    relative(date: DateInput): string {
      return date ? formatDistanceToNowStrict(new Date(date), { locale: dateLocale, addSuffix: true }) : "";
    },
    dateTime(date: DateInput): string {
      return date ? format(new Date(date), "d MMM yyyy, HH:mm", { locale: dateLocale }) : "";
    },
    /** Any date-fns pattern, e.g. "EEEE, d MMMM yyyy", in the current language. */
    date(date: DateInput, pattern: string): string {
      return date ? format(new Date(date), pattern, { locale: dateLocale }) : "";
    },
    duration(start: DateInput, end: DateInput): string {
      if (!start || !end) return "";
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms < 1_000) return `${ms}ms`;
      if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
      return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
    },
  };
}

export type Format = ReturnType<typeof createFormat>;

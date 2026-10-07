"use client";

import { ArrowRight, CalendarRange, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { type QueryParams, useQueryUpdate } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

/** A complete date: typing the year digit by digit passes through 0002, 0020, 0202 first. */
const isComplete = (v: string) => v === "" || /^[1-9]\d{3}-\d{2}-\d{2}$/.test(v);

const dateInput =
  "h-full min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-sm tabular-nums outline-none focus-visible:bg-muted/60 sm:w-34 sm:flex-none [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-50 dark:[&::-webkit-calendar-picker-indicator]:invert";

/**
 * One compact control for the date range. The inputs keep their own value while the user types and push
 * it to the URL after a short pause, so typing a date with the keyboard is not reset by each intermediate value.
 */
export function JournalDateRange({ params, className }: { params: QueryParams; className?: string }) {
  const t = useTranslations("journals.dateRange");
  const { update } = useQueryUpdate(params);
  const [from, setFrom] = useState(params.from ?? "");
  const [to, setTo] = useState(params.to ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Back/forward or a reset changes the URL: show its values.
  const [synced, setSynced] = useState(`${params.from}|${params.to}`);
  if (synced !== `${params.from}|${params.to}`) {
    setSynced(`${params.from}|${params.to}`);
    setFrom(params.from ?? "");
    setTo(params.to ?? "");
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (key: "from" | "to", value: string) => {
    (key === "from" ? setFrom : setTo)(value);
    clearTimeout(timer.current);
    if (!isComplete(value) || value === (params[key] ?? "")) return;
    timer.current = setTimeout(() => update({ [key]: value || null, page: null }), 500);
  };

  const active = !!(params.from || params.to);

  return (
    <div
      role="group"
      aria-label={t("label")}
      className={cn(
        "flex h-8 min-w-0 items-center gap-0.5 rounded-lg border border-input bg-background pr-1 pl-2.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        active && "border-primary/40 bg-primary/5 dark:bg-primary/10",
        className,
      )}
    >
      <CalendarRange className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="date"
        aria-label={t("from")}
        className={dateInput}
        value={from}
        max={to || undefined}
        onChange={(e) => change("from", e.target.value)}
      />
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="date"
        aria-label={t("to")}
        className={dateInput}
        value={to}
        min={from || undefined}
        onChange={(e) => change("to", e.target.value)}
      />
      {active && (
        <button
          type="button"
          aria-label={t("reset")}
          title={t("reset")}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            clearTimeout(timer.current);
            update({ from: null, to: null, page: null });
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useFormat } from "@/hooks/use-format";

/** "5 minutes ago", refreshed every minute; safe from server/client clock hydration mismatches. */
export function RelativeTime({ date, className }: { date: Date | string; className?: string }) {
  const f = useFormat();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <time dateTime={new Date(date).toISOString()} title={f.dateTime(date)} className={className} suppressHydrationWarning>
      {f.relative(date)}
    </time>
  );
}

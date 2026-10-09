"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { useActiveTabInView } from "@/components/app/tab-nav";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { QueryParams } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

/** Params that belong to one tab and are dropped when switching. */
const TAB_SCOPED = new Set(["tab", "page", "project", "agent", "from", "to"]);

/**
 * Tab strip stored in `?tab=`: each tab is a real link (prefetched, opens in a new tab), the other
 * params are kept. The first tab is the default and has no `tab` param.
 */
export function UrlTabs({
  value,
  tabs,
  params,
}: {
  value: string;
  tabs: { value: string; label: string; count?: number; tone?: "warning" }[];
  params: QueryParams;
}) {
  const pathname = usePathname();
  const strip = useRef<HTMLDivElement>(null);
  useActiveTabInView(strip, value);

  const href = (tab: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && !TAB_SCOPED.has(k)) qs.set(k, v);
    if (tab !== tabs[0]?.value) qs.set("tab", tab);
    const s = qs.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  return (
    <Tabs value={value}>
      <TabsList ref={strip} className="max-w-full justify-start overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} asChild className="flex-none px-3">
            <Link href={href(t.value)} scroll={false} aria-current={t.value === value ? "page" : undefined}>
              {t.label}
              {t.count ? (
                <span
                  className={cn(
                    "tabular text-xs",
                    t.tone === "warning"
                      ? "rounded-full bg-warning/15 px-1.5 font-semibold text-warning"
                      : "text-muted-foreground",
                  )}
                >
                  {t.count}
                </span>
              ) : null}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

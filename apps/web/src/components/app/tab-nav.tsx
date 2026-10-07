"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** On narrow screens a tab strip scrolls sideways: keeps the active tab in view whenever `active` changes. */
export function useActiveTabInView(ref: React.RefObject<HTMLElement | null>, active: unknown) {
  useEffect(() => {
    const list = ref.current;
    const tab = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const l = list.getBoundingClientRect();
    const a = tab.getBoundingClientRect();
    list.scrollLeft += a.left - l.left - (l.width - a.width) / 2;
  }, [ref, active]);
}

/**
 * Tab strip driven by URL links, so each tab is linkable and server-rendered: underlined, with an optional
 * icon per tab, on a hairline across the page.
 */
export function TabNav({
  items,
  className,
}: {
  items: { href: string; label: string; active: boolean; icon?: React.ReactNode; count?: number }[];
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeHref = items.find((i) => i.active)?.href;
  useActiveTabInView(listRef, activeHref);

  return (
    <Tabs value={activeHref ?? ""} className={cn("border-b border-border/70", className)}>
      <TabsList
        ref={listRef}
        variant="line"
        className="h-auto! max-w-full justify-start gap-1 overflow-x-auto p-0 [scrollbar-width:none]"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.href}
            value={item.href}
            asChild
            className="h-10 flex-none gap-2 rounded-none px-3 text-muted-foreground group-data-horizontal/tabs:after:bottom-0 after:rounded-full after:bg-primary hover:text-foreground data-[state=active]:text-foreground [&_svg]:text-muted-foreground/80 data-[state=active]:[&_svg]:text-primary"
          >
            <Link href={item.href} scroll={false} aria-current={item.active ? "page" : undefined}>
              {item.icon}
              {item.label}
              {item.count !== undefined && <span className="tabular text-xs text-muted-foreground">{item.count}</span>}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

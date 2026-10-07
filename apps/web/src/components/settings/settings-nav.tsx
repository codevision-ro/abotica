"use client";

import { Boxes, CircleArrowUp, Cpu, KeyRound, ScrollText, Send, Shield, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/settings", label: "providers", icon: Cpu },
  { href: "/settings/general", label: "general", icon: SlidersHorizontal },
  { href: "/settings/sandbox", label: "sandbox", icon: Boxes },
  { href: "/settings/vault", label: "vault", icon: KeyRound },
  { href: "/settings/security", label: "security", icon: Shield },
  { href: "/settings/audit", label: "audit", icon: ScrollText },
  { href: "/settings/telegram", label: "telegram", icon: Send },
  { href: "/settings/updates", label: "updates", icon: CircleArrowUp },
] as const;

/** Vertical list on desktop, horizontally scrollable pills on mobile. */
export function SettingsNav() {
  const t = useTranslations("settings.nav");
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement>(null);
  // On mobile the pills scroll horizontally; keep the active one visible.
  useEffect(() => {
    const el = activeRef.current;
    const nav = el?.closest("nav");
    if (el && nav && nav.scrollWidth > nav.clientWidth) {
      const r = el.getBoundingClientRect();
      const n = nav.getBoundingClientRect();
      nav.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
    }
  }, [pathname]);
  return (
    <nav
      aria-label={t("label")}
      className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:overflow-visible md:px-0"
    >
      <ul className="flex gap-1.5 md:flex-col md:gap-0.5">
        {ITEMS.map((item) => {
          const active = item.href === "/settings" ? pathname === "/settings" : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                ref={active ? activeRef : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group/nav flex items-center gap-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  "h-9 rounded-full border px-3.5 md:h-9 md:rounded-lg md:border-0 md:px-2.5",
                  active
                    ? "border-primary/25 bg-primary/8 font-medium text-foreground dark:bg-primary/15"
                    : "border-border/70 bg-card/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground md:bg-transparent dark:bg-card/40 md:dark:bg-transparent",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    active ? "text-primary" : "text-muted-foreground group-hover/nav:text-foreground",
                  )}
                  aria-hidden
                />
                {t(item.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

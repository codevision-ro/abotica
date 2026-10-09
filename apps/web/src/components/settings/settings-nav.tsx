"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { requestNavigation } from "@/lib/navigation-guard";
import { cn } from "@/lib/utils";
import { isSettingsPageActive, SETTINGS_GROUPS, SETTINGS_PAGES } from "./settings-pages";

/**
 * The settings pages: grouped links on desktop; on mobile, where thirteen pills would not fit, one menu
 * that shows the current page and lists the others by group.
 */
export function SettingsNav() {
  const t = useTranslations("settings.nav");
  const pathname = usePathname();
  const router = useRouter();
  const current = SETTINGS_PAGES.find((page) => isSettingsPageActive(pathname, page.href)) ?? SETTINGS_PAGES[0]!;

  // Lets an unsaved-changes guard on the current page ask first, as a link click would.
  const go = (href: string) => requestNavigation(href, () => router.push(href as never));

  return (
    <>
      <Select value={current.href} onValueChange={go}>
        <SelectTrigger aria-label={t("label")} className="h-10 w-full md:hidden">
          <span className="flex min-w-0 items-center gap-2">
            <current.icon className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-medium">{t(current.key)}</span>
          </span>
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-[min(28rem,70svh)]">
          {SETTINGS_GROUPS.map((group) => (
            <SelectGroup key={group.key}>
              <SelectLabel>{t(`groups.${group.key}`)}</SelectLabel>
              {group.pages.map((page) => (
                <SelectItem key={page.href} value={page.href}>
                  <page.icon aria-hidden />
                  {t(page.key)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      <nav aria-label={t("label")} className="hidden flex-col gap-4 md:flex">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.key} className="flex flex-col gap-0.5">
            <h3 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground/80">{t(`groups.${group.key}`)}</h3>
            <ul className="flex flex-col gap-0.5">
              {group.pages.map((page) => {
                const active = page === current;
                return (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group/nav flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                        active
                          ? "bg-primary/8 font-medium text-foreground dark:bg-primary/15"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <page.icon
                        className={cn(
                          "size-4 shrink-0 transition-colors",
                          active ? "text-primary" : "text-muted-foreground group-hover/nav:text-foreground",
                        )}
                        aria-hidden
                      />
                      {t(page.key)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}

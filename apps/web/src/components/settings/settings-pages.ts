import { Bot, Cpu, KeyRound, type LucideIcon, Send, Server, SlidersHorizontal, UserRound } from "lucide-react";

type SettingsPageKey = "general" | "models" | "agents" | "telegram" | "account" | "keys" | "system";

/** `also`: pages outside the nav that belong to this one (the audit log is opened from System). */
type SettingsPage = { key: SettingsPageKey; href: string; icon: LucideIcon; also?: string[] };

/**
 * The settings pages, for the settings nav and the command menu. Labels live in the `settings.nav`
 * messages: `settings.nav.<key>`.
 */
export const SETTINGS_PAGES: SettingsPage[] = [
  { key: "general", href: "/settings", icon: SlidersHorizontal },
  { key: "models", href: "/settings/models", icon: Cpu },
  { key: "agents", href: "/settings/agents", icon: Bot },
  { key: "telegram", href: "/settings/telegram", icon: Send },
  { key: "account", href: "/settings/account", icon: UserRound },
  { key: "keys", href: "/settings/keys", icon: KeyRound },
  { key: "system", href: "/settings/system", icon: Server, also: ["/settings/audit"] },
];

const matches = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** General sits at /settings itself, so it matches only exactly; the others match their subpages too. */
export const isSettingsPageActive = (pathname: string, page: SettingsPage) =>
  page.href === "/settings" ? pathname === page.href : [page.href, ...(page.also ?? [])].some((h) => matches(pathname, h));

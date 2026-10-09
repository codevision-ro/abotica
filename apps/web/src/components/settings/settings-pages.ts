import {
  AppWindow,
  Boxes,
  Bot,
  Brain,
  CalendarClock,
  Cpu,
  KeyRound,
  type LucideIcon,
  ScrollText,
  Send,
  Server,
  Shield,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";

type SettingsPageKey =
  | "general"
  | "models"
  | "agents"
  | "memory"
  | "sandbox"
  | "previews"
  | "telegram"
  | "reports"
  | "security"
  | "secrets"
  | "budget"
  | "system"
  | "audit";
type SettingsGroupKey = "workspace" | "ai" | "execution" | "notifications" | "account" | "system";

export type SettingsPage = { key: SettingsPageKey; href: string; icon: LucideIcon };

/**
 * The settings pages by group, for the settings nav and the command menu. Labels live in the
 * `settings.nav` messages: `settings.nav.groups.<group>` and `settings.nav.<key>`.
 */
export const SETTINGS_GROUPS: { key: SettingsGroupKey; pages: SettingsPage[] }[] = [
  { key: "workspace", pages: [{ key: "general", href: "/settings", icon: SlidersHorizontal }] },
  {
    key: "ai",
    pages: [
      { key: "models", href: "/settings/models", icon: Cpu },
      { key: "agents", href: "/settings/agents", icon: Bot },
      { key: "memory", href: "/settings/memory", icon: Brain },
    ],
  },
  {
    key: "execution",
    pages: [
      { key: "sandbox", href: "/settings/sandbox", icon: Boxes },
      { key: "previews", href: "/settings/previews", icon: AppWindow },
    ],
  },
  {
    key: "notifications",
    pages: [
      { key: "telegram", href: "/settings/telegram", icon: Send },
      { key: "reports", href: "/settings/reports", icon: CalendarClock },
    ],
  },
  {
    key: "account",
    pages: [
      { key: "security", href: "/settings/security", icon: Shield },
      { key: "secrets", href: "/settings/secrets", icon: KeyRound },
      { key: "budget", href: "/settings/budget", icon: Wallet },
    ],
  },
  {
    key: "system",
    pages: [
      { key: "system", href: "/settings/system", icon: Server },
      { key: "audit", href: "/settings/audit", icon: ScrollText },
    ],
  },
];

export const SETTINGS_PAGES = SETTINGS_GROUPS.flatMap((group) => group.pages);

/** General sits at /settings itself, so it matches only exactly; the others match their subpages too. */
export const isSettingsPageActive = (pathname: string, href: string) =>
  href === "/settings" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

import {
  AppWindow,
  Blocks,
  Bot,
  Brain,
  CalendarClock,
  FolderKanban,
  House,
  Inbox,
  MessagesSquare,
  Plug,
  Settings,
  SquareKanban,
  Wallet,
} from "lucide-react";

type NavItemKey =
  | "chat"
  | "dashboard"
  | "inbox"
  | "tasks"
  | "projects"
  | "previews"
  | "agents"
  | "memory"
  | "automations"
  | "costs"
  | "skills"
  | "mcp"
  | "settings";
type NavGroupKey = "work" | "operations" | "setup";

/**
 * Labels live in the `nav` messages: `nav.groups.<group>` and `nav.items.<key>`. `also` lists pages
 * outside the sidebar that light up the item (the approvals page is reached from the inbox).
 */
type NavItem = { key: NavItemKey; href: string; icon: typeof Bot; also?: string[] };

/** Runs and approvals have no item of their own: Home, tasks and costs link to runs, the inbox to approvals. */
export const NAV: { key: NavGroupKey; items: NavItem[] }[] = [
  {
    key: "work",
    items: [
      { key: "chat", href: "/chat", icon: MessagesSquare },
      { key: "dashboard", href: "/", icon: House },
      { key: "inbox", href: "/inbox", icon: Inbox, also: ["/approvals"] },
      { key: "tasks", href: "/tasks", icon: SquareKanban },
      { key: "projects", href: "/projects", icon: FolderKanban },
      { key: "previews", href: "/previews", icon: AppWindow },
      { key: "agents", href: "/agents", icon: Bot },
    ],
  },
  {
    key: "operations",
    items: [
      { key: "memory", href: "/memory", icon: Brain, also: ["/journals"] },
      { key: "automations", href: "/automations", icon: CalendarClock },
      { key: "costs", href: "/costs", icon: Wallet },
    ],
  },
  {
    key: "setup",
    items: [
      { key: "skills", href: "/skills", icon: Blocks },
      { key: "mcp", href: "/mcp", icon: Plug },
      { key: "settings", href: "/settings", icon: Settings },
    ],
  },
];

const matches = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

export const isActive = (pathname: string, item: Pick<NavItem, "href" | "also">) =>
  [item.href, ...(item.also ?? [])].some((href) => matches(pathname, href));

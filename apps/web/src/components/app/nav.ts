import {
  Activity,
  AppWindow,
  Blocks,
  Bot,
  BookOpen,
  Brain,
  CalendarClock,
  FolderKanban,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  Settings,
  ShieldCheck,
  SquareKanban,
  Wallet,
} from "lucide-react";

type NavItemKey =
  | "dashboard"
  | "chat"
  | "tasks"
  | "projects"
  | "previews"
  | "agents"
  | "memory"
  | "journals"
  | "runs"
  | "approvals"
  | "automations"
  | "costs"
  | "skills"
  | "mcp"
  | "settings";
type NavGroupKey = "main" | "memory" | "operations" | "configuration";

/** Labels live in the `nav` messages: `nav.groups.<group>` and `nav.items.<key>`. */
type NavItem = { key: NavItemKey; href: string; icon: typeof Bot };

export const NAV: { key: NavGroupKey; items: NavItem[] }[] = [
  {
    key: "main",
    items: [
      { key: "dashboard", href: "/", icon: LayoutDashboard },
      { key: "chat", href: "/chat", icon: MessagesSquare },
      { key: "tasks", href: "/tasks", icon: SquareKanban },
      { key: "projects", href: "/projects", icon: FolderKanban },
      { key: "previews", href: "/previews", icon: AppWindow },
      { key: "agents", href: "/agents", icon: Bot },
    ],
  },
  {
    key: "memory",
    items: [
      { key: "memory", href: "/memory", icon: Brain },
      { key: "journals", href: "/journals", icon: BookOpen },
    ],
  },
  {
    key: "operations",
    items: [
      { key: "runs", href: "/runs", icon: Activity },
      { key: "approvals", href: "/approvals", icon: ShieldCheck },
      { key: "automations", href: "/automations", icon: CalendarClock },
      { key: "costs", href: "/costs", icon: Wallet },
    ],
  },
  {
    key: "configuration",
    items: [
      { key: "skills", href: "/skills", icon: Blocks },
      { key: "mcp", href: "/mcp", icon: Plug },
      { key: "settings", href: "/settings", icon: Settings },
    ],
  },
];

export const isActive = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

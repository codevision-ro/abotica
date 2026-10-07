import type { BuiltinMcpKey } from "@abotica/core/mcp-builtins";
import {
  BookOpenTextIcon,
  GlobeIcon,
  type LucideIcon,
  MousePointerClickIcon,
  ScanTextIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "size-7 rounded-lg [&_svg]:size-4",
  xl: "size-12 rounded-xl [&_svg]:size-6",
  "2xl": "size-16 rounded-2xl [&_svg]:size-8",
} as const;

/** What each bundled server does, at a glance. */
const BUILTIN_ICONS: Record<BuiltinMcpKey, LucideIcon> = {
  "parallel-search": SearchIcon,
  context7: BookOpenTextIcon,
  playwright: MousePointerClickIcon,
  scrapling: ScanTextIcon,
};

/**
 * Icon tile of an MCP server: its own icon for a bundled server, otherwise a globe for remote (HTTP)
 * servers and a terminal for local (stdio) ones.
 */
export function McpServerIcon({
  transport,
  builtin,
  size,
  className,
}: {
  transport: "http" | "stdio";
  /** Key of a bundled server. */
  builtin?: string | null;
  size: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = (builtin && BUILTIN_ICONS[builtin as BuiltinMcpKey]) || (transport === "http" ? GlobeIcon : TerminalIcon);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-primary/8 text-primary shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:bg-primary/15 dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        SIZES[size],
        className,
      )}
    >
      <Icon />
    </span>
  );
}

"use client";

import { TOOL_PERMISSIONS, type ToolPermission } from "@abotica/core/agents/permissions";
import { BanIcon, CircleCheckIcon, HandIcon, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const PERMISSION_ICONS: Record<ToolPermission, LucideIcon> = {
  allow: CircleCheckIcon,
  ask: HandIcon,
  deny: BanIcon,
};

/** Text color by meaning; warning and success are darkened in light mode to stay readable. */
export const PERMISSION_TEXT: Record<ToolPermission, string> = {
  allow: "text-[color-mix(in_oklch,var(--success),black_20%)] dark:text-success",
  ask: "text-[color-mix(in_oklch,var(--warning),black_40%)] dark:text-warning",
  deny: "text-destructive",
};

/** Tints of the chosen option, keyed on `aria-checked` because the tooltip trigger takes over `data-state`. */
const SELECTED: Record<ToolPermission, string> = {
  allow:
    "aria-checked:bg-success/12 aria-checked:text-[color-mix(in_oklch,var(--success),black_20%)] dark:aria-checked:bg-success/15 dark:aria-checked:text-success",
  ask: "aria-checked:bg-warning/18 aria-checked:text-[color-mix(in_oklch,var(--warning),black_45%)] dark:aria-checked:bg-warning/15 dark:aria-checked:text-warning",
  deny: "aria-checked:bg-destructive/10 aria-checked:text-destructive dark:aria-checked:bg-destructive/18",
};

/**
 * Allow / Ask / Deny as one segmented radio control of icons, each named by aria-label and a
 * tooltip that also explains the option. `mixed` selects nothing (a group whose items differ); choosing an option never clears
 * the selection.
 */
export function PermissionControl({
  value,
  onChange,
  label,
  disabled,
  className,
}: {
  value: ToolPermission | "mixed";
  onChange: (permission: ToolPermission) => void;
  /** Accessible name, e.g. "Permission for Search memory". */
  label: string;
  /** Options that cannot be chosen. */
  disabled?: readonly ToolPermission[];
  className?: string;
}) {
  const t = useTranslations("agents.permissions");
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      value={value === "mixed" ? "" : value}
      onValueChange={(next) => next && onChange(next as ToolPermission)}
      aria-label={label}
      className={cn("shrink-0", className)}
    >
      {TOOL_PERMISSIONS.map((p) => {
        const Icon = PERMISSION_ICONS[p];
        const name = t(`options.${p}`);
        return (
          <Tooltip key={p}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={p}
                disabled={disabled?.includes(p)}
                aria-label={name}
                className={cn("size-8 text-muted-foreground", SELECTED[p])}
              >
                <Icon aria-hidden />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-medium">{name}</span>: {t(`legend.${p}`)}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

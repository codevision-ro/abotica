"use client";

import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";

/** A bordered row with a title, a hint and a switch; the whole row toggles it. */
export function McpSwitchRow({
  id,
  title,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  title: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-3 rounded-xl border bg-background/60 p-3 dark:bg-input/10"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-pretty text-muted-foreground">{hint}</span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

/** "Available to all agents": a global server reaches every agent without an assignment. */
export function McpGlobalSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const t = useTranslations("mcp.form");
  return (
    <McpSwitchRow
      id="mcp-global"
      title={t("globalTitle")}
      hint={t("globalHint")}
      checked={checked}
      onCheckedChange={onCheckedChange}
    />
  );
}

/** "Active": a disabled server is not offered to any agent. */
export function McpActiveSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const t = useTranslations("mcp.form");
  return (
    <McpSwitchRow
      id="mcp-enabled"
      title={t("active")}
      hint={t("activeHint")}
      checked={checked}
      onCheckedChange={onCheckedChange}
    />
  );
}

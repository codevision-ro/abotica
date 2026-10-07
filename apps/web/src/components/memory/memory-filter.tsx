"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { Bot, FolderKanban } from "lucide-react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type QueryParams, useQueryUpdate } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

const ALL = "__all";

const ICONS = { agent: Bot, project: FolderKanban } as const;

/** Compact filter stored in one query param; it is tinted while a value is chosen. */
export function ParamSelect({
  param,
  params,
  label,
  allLabel,
  options,
  icon,
  className,
}: {
  param: string;
  params: QueryParams;
  label: string;
  allLabel: string;
  options: { id: string; name: string; avatar?: AgentAvatarValue | null }[];
  /** Icon before the "all" choice and on options without an avatar (a name: server pages render this). */
  icon?: keyof typeof ICONS;
  className?: string;
}) {
  const { update } = useQueryUpdate(params);
  const Icon = icon ? ICONS[icon] : null;
  const active = !!params[param];
  return (
    <Select value={params[param] ?? ALL} onValueChange={(v) => update({ [param]: v === ALL ? null : v, page: null })}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          "w-full bg-background sm:w-52 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2",
          active && "border-primary/40 bg-primary/5 dark:bg-primary/10",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-w-[calc(100vw-2rem)]">
        <SelectItem value={ALL} className="*:[span]:last:min-w-0">
          {Icon && <Icon className="text-muted-foreground" />}
          <span className="truncate">{allLabel}</span>
        </SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="*:[span]:last:min-w-0">
            {o.avatar ? <AgentAvatar avatar={o.avatar} size="xs" /> : Icon && <Icon className="text-muted-foreground" />}
            <span className="truncate">{o.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

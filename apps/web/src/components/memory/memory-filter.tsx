"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { Bot, FolderKanban, Globe, ShieldCheck } from "lucide-react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { type QueryParams, useQueryUpdate } from "@/hooks/use-query-update";
import { cn } from "@/lib/utils";

const ALL = "__all";

const ICONS = { agent: Bot, project: FolderKanban, global: Globe, origin: ShieldCheck } as const;

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
  /** `icon` replaces the select's icon on one option, e.g. a globe on a "global only" choice. */
  options: { id: string; name: string; avatar?: AgentAvatarValue | null; icon?: keyof typeof ICONS }[];
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
        {options.map((o) => {
          const OptionIcon = o.icon ? ICONS[o.icon] : Icon;
          return (
            <SelectItem key={o.id} value={o.id} className="*:[span]:last:min-w-0">
              {o.avatar ? (
                <AgentAvatar avatar={o.avatar} size="xs" />
              ) : (
                OptionIcon && <OptionIcon className="text-muted-foreground" />
              )}
              <span className="truncate">{o.name}</span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** On/off filter stored as `param=1`; tinted while on, like ParamSelect. */
export function ParamToggle({
  param,
  params,
  title,
  children,
}: {
  param: string;
  params: QueryParams;
  /** What the filter keeps, when the label alone does not say. */
  title?: string;
  /** Icon and label. */
  children: React.ReactNode;
}) {
  const { update } = useQueryUpdate(params);
  return (
    <Toggle
      variant="outline"
      title={title}
      pressed={params[param] === "1"}
      onPressedChange={(on) => update({ [param]: on ? "1" : null, page: null })}
      className="bg-background font-normal data-[state=on]:border-primary/40 data-[state=on]:bg-primary/5 dark:bg-input/30 dark:data-[state=on]:bg-primary/10 [&_svg]:text-muted-foreground"
    >
      {children}
    </Toggle>
  );
}

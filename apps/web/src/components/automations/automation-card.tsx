"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { type LucideIcon, PlusIcon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { listCardClass, sectionCardClass, SectionIcon } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A tab of schedules or triggers: the toolbar (e.g. the page's tabs) left of the "New" button, the cards
 * in a grid or the empty note, then the tab's dialogs.
 */
export function AutomationList({
  toolbar,
  newLabel,
  onNew,
  canCreate,
  empty,
  cards,
  children,
}: {
  toolbar?: React.ReactNode;
  newLabel: string;
  onNew: () => void;
  canCreate: boolean;
  empty: string;
  cards: React.ReactNode[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {toolbar}
        <div className="ml-auto">
          <Button onClick={onNew} disabled={!canCreate}>
            <PlusIcon /> {newLabel}
          </Button>
        </div>
      </div>
      {cards.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{cards}</div>
      ) : (
        <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>{empty}</p>
      )}
      {children}
    </div>
  );
}

/** The enable switch of a card; `save` stores the new state and a failure shows as a toast. */
export function AutomationSwitch({
  checked,
  label,
  save,
}: {
  checked: boolean;
  label: string;
  save: (enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={checked}
      disabled={pending}
      aria-label={label}
      onCheckedChange={(enabled) =>
        startTransition(async () => {
          const res = await save(enabled);
          if (!res.ok) toast.error(res.error);
        })
      }
    />
  );
}

/** Icon button with its label in a tooltip. */
export function IconAction({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One schedule or trigger: the agent's avatar next to the name and who runs it, the switch on the right,
 * details below and a footer with actions. Clicking the card opens it for editing.
 */
export function AutomationCard({
  name,
  agentName,
  agentAvatar,
  projectName,
  enabled,
  editLabel,
  onEdit,
  toggle,
  children,
  footer,
}: {
  name: string;
  agentName: string;
  agentAvatar: AgentAvatarValue | null;
  projectName: string | null;
  enabled: boolean;
  editLabel: string;
  onEdit: () => void;
  /** The enable switch. */
  toggle: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className={cn(listCardClass, !enabled && "bg-card/60 dark:bg-card/40")}>
      <div className="flex items-center gap-3">
        <AgentAvatar avatar={agentAvatar} size="xl" className={cn(!enabled && "opacity-60 grayscale-[0.4]")} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`${editLabel}: ${name}`}
            title={name}
            className="line-clamp-2 text-left font-medium wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
          >
            {name}
          </button>
          <p
            className="truncate text-sm text-muted-foreground"
            title={[agentName, projectName].filter(Boolean).join(" · ")}
          >
            {agentName}
            {projectName && <span> · {projectName}</span>}
          </p>
        </div>
        <div className="relative z-10">{toggle}</div>
      </div>
      {children}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t pt-3">{footer}</div>
    </div>
  );
}

/** Icon and text line inside a card, e.g. when a schedule runs or which event starts a trigger. */
export function AutomationDetail({
  icon: Icon,
  title,
  meta,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <SectionIcon icon={Icon} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
      </div>
    </div>
  );
}

/** The run prompt, two lines at most. */
export function AutomationPrompt({ prompt }: { prompt: string }) {
  return (
    <p className="line-clamp-2 text-sm text-muted-foreground wrap-anywhere" title={prompt}>
      {prompt}
    </p>
  );
}

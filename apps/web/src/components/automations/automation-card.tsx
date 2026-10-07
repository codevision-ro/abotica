"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { cn } from "@/lib/utils";

/** Grid the schedule and trigger cards sit in. */
export const automationGridClass = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

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
    <div
      className={cn(
        "group relative flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40",
        !enabled && "bg-card/60 dark:bg-card/40",
      )}
    >
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
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
        <Icon className="size-4" aria-hidden />
      </span>
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

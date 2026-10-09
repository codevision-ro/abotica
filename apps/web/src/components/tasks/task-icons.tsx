import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  ContrastIcon,
  type LucideIcon,
  OctagonAlertIcon,
  PauseCircleIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
  UserIcon,
} from "lucide-react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PRIORITIES, useStatusLabels } from "@/components/app/status-badge";
import { SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { icon: LucideIcon; className: string }> = {
  backlog: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  in_progress: { icon: ContrastIcon, className: "text-primary" },
  blocked: { icon: CircleSlashIcon, className: "text-destructive" },
  review: { icon: CircleDotIcon, className: "text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning" },
  done: { icon: CircleCheckIcon, className: "text-success" },
  paused: { icon: PauseCircleIcon, className: "text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning" },
  cancelled: { icon: CircleXIcon, className: "text-muted-foreground" },
};

const PRIORITY: Record<string, { icon: LucideIcon; className: string }> = {
  low: { icon: SignalLowIcon, className: "text-muted-foreground" },
  medium: { icon: SignalMediumIcon, className: "text-muted-foreground" },
  high: { icon: SignalHighIcon, className: "text-foreground" },
  urgent: { icon: OctagonAlertIcon, className: "text-destructive" },
};

/** Status as a small colored circle icon, the same in board headers, rows and selects. */
export function TaskStatusIcon({ status, label }: { status: string; label?: string }) {
  const { icon: Icon, className: tone } = STATUS[status] ?? STATUS.backlog!;
  return (
    <Icon
      className={cn("size-4 shrink-0", tone)}
      strokeWidth={2.25}
      aria-hidden={!label}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

function TaskPriorityIcon({ priority }: { priority: string }) {
  const { icon: Icon, className: tone } = PRIORITY[priority] ?? PRIORITY.medium!;
  return <Icon className={cn("size-4 shrink-0", tone)} strokeWidth={2.25} aria-hidden />;
}

/** For select triggers whose value has an icon or avatar before the label: keeps both on one line. */
export const SELECT_WITH_MEDIA =
  "*:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2";

/** "You" or "nobody" in places where agents show their avatar. */
export function PersonTile({ empty }: { empty?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md",
        empty ? "border border-dashed border-muted-foreground/40 text-muted-foreground" : "bg-primary/10 text-primary",
      )}
    >
      <UserIcon className="size-3!" />
    </span>
  );
}

/** An agent as a select option: its avatar and name. */
export function AgentSelectItem({ agent }: { agent: { id: string; name: string; avatar: AgentAvatarValue | null } }) {
  return (
    <SelectItem value={agent.id} title={agent.name} className="*:[span]:last:min-w-0">
      <AgentAvatar avatar={agent.avatar} size="xs" />
      <span className="truncate">{agent.name}</span>
    </SelectItem>
  );
}

/** The priorities as select options with their icons, lowest first (or highest first when `reversed`). */
export function PrioritySelectItems({ reversed }: { reversed?: boolean }) {
  const labels = useStatusLabels();
  return (reversed ? [...PRIORITIES].reverse() : PRIORITIES).map((p) => (
    <SelectItem key={p} value={p}>
      <TaskPriorityIcon priority={p} />
      {labels.priority(p)}
    </SelectItem>
  ));
}

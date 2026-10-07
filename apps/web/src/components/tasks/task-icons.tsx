import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ContrastIcon,
  type LucideIcon,
  OctagonAlertIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { icon: LucideIcon; className: string }> = {
  backlog: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  in_progress: { icon: ContrastIcon, className: "text-primary" },
  blocked: { icon: CircleSlashIcon, className: "text-destructive" },
  review: { icon: CircleDotIcon, className: "text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning" },
  done: { icon: CircleCheckIcon, className: "text-success" },
};

const PRIORITY: Record<string, { icon: LucideIcon; className: string }> = {
  low: { icon: SignalLowIcon, className: "text-muted-foreground" },
  medium: { icon: SignalMediumIcon, className: "text-muted-foreground" },
  high: { icon: SignalHighIcon, className: "text-foreground" },
  urgent: { icon: OctagonAlertIcon, className: "text-destructive" },
};

/** Status as a small colored circle icon, the same in board headers, rows and selects. */
export function TaskStatusIcon({ status, label, className }: { status: string; label?: string; className?: string }) {
  const { icon: Icon, className: tone } = STATUS[status] ?? STATUS.backlog!;
  return (
    <Icon
      className={cn("size-4 shrink-0", tone, className)}
      strokeWidth={2.25}
      aria-hidden={!label}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

export function TaskPriorityIcon({ priority, className }: { priority: string; className?: string }) {
  const { icon: Icon, className: tone } = PRIORITY[priority] ?? PRIORITY.medium!;
  return <Icon className={cn("size-4 shrink-0", tone, className)} strokeWidth={2.25} aria-hidden />;
}

/** For select triggers whose value has an icon or avatar before the label: keeps both on one line. */
export const SELECT_WITH_MEDIA =
  "*:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2";

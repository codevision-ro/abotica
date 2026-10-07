import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type Tone = "muted" | "primary" | "warning" | "success" | "destructive";

const TONES: Record<Tone, string> = {
  muted: "bg-muted text-muted-foreground",
  primary: "bg-primary/10 text-primary",
  warning: "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
  success: "bg-success/12 text-success",
  destructive: "bg-destructive/10 text-destructive",
};

export function ToneBadge({
  tone,
  children,
  pulse,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  pulse?: boolean;
  title?: string;
}) {
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-transparent font-medium", TONES[tone])} title={title}>
      <span className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")} />
      {children}
    </Badge>
  );
}

export const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const;
export const TASK_STATUSES = ["backlog", "in_progress", "blocked", "review", "done"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const TRIGGERS = ["chat", "telegram", "task", "schedule", "webhook", "event", "delegation", "system"] as const;

const RUN_TONE: Record<string, Tone> = {
  queued: "muted",
  running: "primary",
  waiting_approval: "warning",
  succeeded: "success",
  failed: "destructive",
  cancelled: "muted",
};
const TASK_TONE: Record<string, Tone> = {
  backlog: "muted",
  in_progress: "primary",
  blocked: "destructive",
  review: "warning",
  done: "success",
};
const PRIORITY_TONE: Record<string, Tone> = { low: "muted", medium: "primary", high: "warning", urgent: "destructive" };

/** Labels for the enums above, in the current language. Unknown values are shown as-is. */
export function useStatusLabels() {
  const t = useTranslations("common");
  const pick = (group: "runStatus" | "taskStatus" | "priority" | "trigger", value: string) => {
    const key = `${group}.${value}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : value;
  };
  return {
    run: (status: string) => pick("runStatus", status),
    task: (status: string) => pick("taskStatus", status),
    priority: (priority: string) => pick("priority", priority),
    trigger: (trigger: string) => pick("trigger", trigger),
  };
}

export function RunStatusBadge({ status }: { status: string }) {
  const labels = useStatusLabels();
  return (
    <ToneBadge tone={RUN_TONE[status] ?? "muted"} pulse={status === "running"}>
      {labels.run(status)}
    </ToneBadge>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const labels = useStatusLabels();
  return <ToneBadge tone={TASK_TONE[status] ?? "muted"}>{labels.task(status)}</ToneBadge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const labels = useStatusLabels();
  return <ToneBadge tone={PRIORITY_TONE[priority] ?? "muted"}>{labels.priority(priority)}</ToneBadge>;
}

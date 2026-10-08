"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarClockIcon, FolderIcon, ListChecksIcon, MessageSquareIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PriorityBadge } from "@/components/app/status-badge";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import type { BoardTask } from "@/server/queries/tasks";
import { isOverdue, rememberOverlayBase } from "./task-meta";
import { PullRequestBadge } from "./task-pull-request";

export function TaskAssignee({
  agentName,
  agentAvatar,
  assignedToUser,
  className,
}: {
  agentName: string | null;
  agentAvatar: AgentAvatarValue | null;
  assignedToUser: boolean;
  className?: string;
}) {
  const t = useTranslations("tasks.assignee");
  if (agentName) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
        <AgentAvatar avatar={agentAvatar} size="xs" />
        <span className="truncate" title={agentName}>
          {agentName}
        </span>
      </span>
    );
  }
  if (assignedToUser) {
    return (
      <span className={cn("inline-flex items-center gap-1.5", className)}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <UserIcon className="size-3" />
        </span>
        {t("you")}
      </span>
    );
  }
  return <span className={cn("text-muted-foreground", className)}>{t("unassigned")}</span>;
}

export function TaskDeadline({ deadline, status }: { deadline: Date | string | null; status: string }) {
  const fmt = useFormat();
  if (!deadline) return null;
  const overdue = isOverdue(deadline, status);
  return (
    <span className={cn("inline-flex items-center gap-1 tabular", overdue ? "text-destructive" : "text-muted-foreground")}>
      <CalendarClockIcon className="size-3.5" />
      {fmt.date(deadline, "d MMM, HH:mm")}
    </span>
  );
}

/** Pulsing dot for tasks with a queued or running run. */
export function ActiveRunDot({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("relative flex size-2 shrink-0", className)} title={label} role="img" aria-label={label}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  );
}

/** Only the avatar, for compact rows; the name is in the tooltip. */
export function TaskAssigneeAvatar({
  agentName,
  agentAvatar,
  assignedToUser,
}: {
  agentName: string | null;
  agentAvatar: AgentAvatarValue | null;
  assignedToUser: boolean;
}) {
  const t = useTranslations("tasks.assignee");
  const label = agentName ?? (assignedToUser ? t("you") : t("unassigned"));
  return (
    <span title={label} className="flex shrink-0" role="img" aria-label={label}>
      {agentName ? (
        <AgentAvatar avatar={agentAvatar} size="sm" />
      ) : assignedToUser ? (
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <UserIcon className="size-3.5" />
        </span>
      ) : (
        <span className="flex size-6 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground">
          <UserIcon className="size-3.5" />
        </span>
      )}
    </span>
  );
}

export function TaskCard({
  task,
  href,
  dragging,
  overlay,
}: {
  task: BoardTask;
  href: string;
  dragging?: boolean;
  overlay?: boolean;
}) {
  const t = useTranslations("tasks.card");
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card p-3 text-sm shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-sm dark:bg-card/80",
        dragging && "opacity-40",
        overlay && "rotate-1 cursor-grabbing border-primary/40 shadow-lg ring-1 ring-primary/20",
      )}
    >
      {(task.projectName || task.hasActiveRun) && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {task.projectName && (
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate" title={task.projectName}>
                {task.projectName}
              </span>
            </span>
          )}
          {task.hasActiveRun && <ActiveRunDot label={t("activeRun")} className="ml-auto" />}
        </div>
      )}
      <Link
        href={href}
        scroll={false}
        draggable={false}
        onClick={overlay ? undefined : rememberOverlayBase}
        title={task.title}
        className="line-clamp-3 leading-snug font-medium break-words outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
      >
        {task.title}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs">
        <PriorityBadge priority={task.priority} />
        <TaskDeadline deadline={task.deadline} status={task.status} />
        {task.pullRequests.map((pr) => (
          <PullRequestBadge key={pr.id} pr={pr} />
        ))}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <TaskAssignee
          agentName={task.agentName}
          agentAvatar={task.agentAvatar}
          assignedToUser={task.assignedToUser}
          className="min-w-0 text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-2.5 text-muted-foreground tabular">
          {task.subtaskTotal > 0 && (
            <span className="inline-flex items-center gap-1" title={t("subtasksDone")}>
              <ListChecksIcon className="size-3.5" />
              {task.subtaskDone}/{task.subtaskTotal}
            </span>
          )}
          {task.commentCount > 0 && (
            <span className="inline-flex items-center gap-1" title={t("comments")}>
              <MessageSquareIcon className="size-3.5" />
              {task.commentCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SortableTaskCard({ task, href }: { task: BoardTask; href: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", status: task.status },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="touch-manipulation cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} href={href} dragging={isDragging} />
    </div>
  );
}

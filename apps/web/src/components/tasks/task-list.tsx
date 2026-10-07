"use client";

import { FolderIcon, ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { sectionCardClass } from "@/components/app/section-card";
import { PriorityBadge, TaskStatusBadge, useStatusLabels } from "@/components/app/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { BoardTask } from "@/server/queries/tasks";
import { ActiveRunDot, TaskAssignee, TaskAssigneeAvatar, TaskDeadline } from "./task-card";
import { TaskStatusIcon } from "./task-icons";
import { PRIORITY_RANK, rememberOverlayBase, useTaskParams } from "./task-meta";

export function TaskList({ tasks }: { tasks: BoardTask[] }) {
  const t = useTranslations("tasks");
  const labels = useStatusLabels();
  const { hrefWith, openOverlay } = useTaskParams();
  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
        if (byPriority) return byPriority;
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        return da - db;
      }),
    [tasks],
  );

  return (
    <div
      className={cn(
        sectionCardClass,
        "min-h-0 overflow-y-auto md:overflow-auto md:[&_[data-slot=table-container]]:overflow-visible",
      )}
    >
      <ul className="divide-y divide-border/60 md:hidden">
        {sorted.map((task) => (
          <li key={task.id}>
            <Link
              href={hrefWith({ task: task.id })}
              scroll={false}
              onClick={rememberOverlayBase}
              className="flex items-center gap-3 px-4 py-3 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
            >
              <TaskStatusIcon status={task.status} label={labels.task(task.status)} />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="line-clamp-2 min-w-0 text-sm font-medium break-words" title={task.title}>
                    {task.title}
                  </span>
                  {task.hasActiveRun && <ActiveRunDot label={t("card.activeRun")} />}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                  <PriorityBadge priority={task.priority} />
                  <TaskDeadline deadline={task.deadline} status={task.status} />
                  {task.subtaskTotal > 0 && (
                    <span className="inline-flex items-center gap-1 tabular">
                      <ListChecksIcon className="size-3.5" />
                      {t("list.subtaskCount", { done: task.subtaskDone, total: task.subtaskTotal })}
                    </span>
                  )}
                  {task.projectName && (
                    <span className="inline-flex min-w-0 items-center gap-1" title={task.projectName}>
                      <FolderIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{task.projectName}</span>
                    </span>
                  )}
                </span>
              </span>
              <TaskAssigneeAvatar
                agentName={task.agentName}
                agentAvatar={task.agentAvatar}
                assignedToUser={task.assignedToUser}
              />
            </Link>
          </li>
        ))}
      </ul>
      <Table className="hidden min-w-[52rem] md:table">
        <TableHeader className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm [&_tr]:border-border/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 pl-5 text-xs font-medium text-muted-foreground">{t("list.columns.title")}</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">{t("list.columns.status")}</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">{t("list.columns.priority")}</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">{t("list.columns.assignee")}</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">{t("list.columns.project")}</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">{t("list.columns.deadline")}</TableHead>
            <TableHead className="h-9 pr-5 text-right text-xs font-medium text-muted-foreground">
              {t("list.columns.subtasks")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((task) => (
            <TableRow
              key={task.id}
              className="h-12 cursor-pointer border-border/60 hover:bg-muted/40"
              onClick={() => openOverlay({ task: task.id })}
            >
              <TableCell className="w-full max-w-0 pl-5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Link
                    href={hrefWith({ task: task.id })}
                    scroll={false}
                    title={task.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      rememberOverlayBase(e);
                    }}
                    className="truncate font-medium hover:underline"
                  >
                    {task.title}
                  </Link>
                  {task.hasActiveRun && <ActiveRunDot label={t("card.activeRun")} />}
                </div>
              </TableCell>
              <TableCell>
                <TaskStatusBadge status={task.status} />
              </TableCell>
              <TableCell>
                <PriorityBadge priority={task.priority} />
              </TableCell>
              <TableCell className="max-w-40">
                <TaskAssignee
                  agentName={task.agentName}
                  agentAvatar={task.agentAvatar}
                  assignedToUser={task.assignedToUser}
                  className="max-w-full"
                />
              </TableCell>
              <TableCell className="max-w-40 truncate text-muted-foreground" title={task.projectName ?? undefined}>
                {task.projectName ?? "-"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {task.deadline ? <TaskDeadline deadline={task.deadline} status={task.status} /> : "-"}
              </TableCell>
              <TableCell className="pr-5 text-right text-muted-foreground tabular">
                {task.subtaskTotal ? `${task.subtaskDone}/${task.subtaskTotal}` : "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

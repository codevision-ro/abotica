"use client";

import type { DelegationReportMetadata } from "@abotica/core/delegation-report";
import { ChevronRight, Workflow } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { TaskStatusBadge } from "@/components/app/status-badge";
import { ChatFileChip } from "./chat-file-card";
import { MessageTime } from "./chat-parts";

/** Delegated tasks reporting back: shown as a platform notice, not as a message the user wrote. */
export function DelegationNotice({ report, date }: { report: DelegationReportMetadata; date: string | undefined }) {
  const t = useTranslations("chat.delegation");
  return (
    <div className="mx-auto w-full max-w-xl shrink-0 overflow-hidden rounded-xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary dark:bg-primary/15">
          <Workflow className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {t("title", { count: report.tasks.length })}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/80">
          <MessageTime date={date} />
        </span>
      </div>
      {report.withheld && <p className="px-3 pb-2.5 text-xs text-muted-foreground">{t("withheld")}</p>}
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <ul className="divide-y divide-border/60">
        {report.tasks.map((task) => (
          <li key={task.id}>
            <Link
              href={`/tasks/${task.id}`}
              className="group/task flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium" title={task.title}>
                  {task.title}
                </div>
                {task.agent && <div className="truncate text-xs text-muted-foreground">{task.agent}</div>}
              </div>
              <TaskStatusBadge status={task.status} />
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/task:translate-x-0.5" />
            </Link>
            {task.files?.length ? (
              <ul className="-mt-1 flex flex-wrap gap-1.5 px-3 pb-2.5" aria-label={t("files")}>
                {task.files.map((file) => (
                  <li key={file.id} className="max-w-full min-w-0">
                    <ChatFileChip file={file} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

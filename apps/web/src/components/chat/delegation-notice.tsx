"use client";

import type { DelegationReportMetadata } from "@abotica/core/delegation-report";
import type { TaskNoticeKind, TaskNoticeMetadata } from "@abotica/core/task-notices";
import type { UIMessage } from "ai";
import {
  BellIcon,
  ChevronRight,
  CircleHelpIcon,
  CirclePauseIcon,
  HandHelpingIcon,
  MessageSquareReplyIcon,
  SignpostIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ToneBadge, TaskStatusBadge } from "@/components/app/status-badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChatFileChip } from "./chat-file-card";
import { MessageTime } from "./chat-parts";
import { UntrustedText } from "./untrusted-text";

const NOTICE_ICONS: Record<TaskNoticeKind, LucideIcon> = {
  instruction: SignpostIcon,
  question: CircleHelpIcon,
  answer: MessageSquareReplyIcon,
  progress: TrendingUpIcon,
  control: CirclePauseIcon,
  reminder: BellIcon,
  alert: TriangleAlertIcon,
  "help-answer": HandHelpingIcon,
};

/** The notice's text without its first line when that only says it is an automatic notice (the card says so). */
function noticeText(message: UIMessage): string {
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
  return text.replace(/^\s*\[[^\]\n]*\]\s*\n/, "").trim();
}

/**
 * A notice about a task the platform put into the conversation (an instruction, a question, progress, a
 * reminder): shown as a card, never as something the user wrote. Its text opens on request; progress,
 * the most frequent, is the only one shown closed.
 */
export function TaskNotice({
  notice,
  message,
  date,
}: {
  notice: TaskNoticeMetadata;
  message: UIMessage;
  date: string | undefined;
}) {
  const t = useTranslations("chat.taskNotice");
  const Icon = NOTICE_ICONS[notice.notice] ?? BellIcon;
  const text = noticeText(message);
  return (
    <div className="mx-auto w-full max-w-xl shrink-0 overflow-hidden rounded-xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/8 text-primary dark:bg-primary/15">
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {t(`kinds.${notice.notice}`)}
          <span className="font-normal text-muted-foreground"> · {t("from", { from: notice.from })}</span>
        </span>
        {notice.urgent && <ToneBadge tone="destructive">{t("urgent")}</ToneBadge>}
        <span className="shrink-0 text-[11px] text-muted-foreground/80">
          <MessageTime date={date} />
        </span>
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <Link
        href={`/tasks/${notice.taskId}`}
        title={t("openTask")}
        className="group/task flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{notice.taskTitle}</span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/task:translate-x-0.5" />
      </Link>
      {text && (
        <Collapsible defaultOpen={notice.notice !== "progress"} className="group/notice border-t border-border/60">
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset group-data-[state=open]/notice:hidden">
            <ChevronRight className="size-3.5" />
            {t("showMessage")}
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 py-2.5 text-sm whitespace-pre-wrap wrap-anywhere">
            <UntrustedText text={text} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

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

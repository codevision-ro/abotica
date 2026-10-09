import {
  BotIcon,
  CircleHelpIcon,
  HistoryIcon,
  InboxIcon,
  ListTodoIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionCard, sectionCardClass, SectionIcon, SectionList } from "@/components/app/section-card";
import { PriorityBadge, TaskStatusBadge } from "@/components/app/status-badge";
import { ApprovalActions } from "@/components/approvals/approval-actions";
import { ToolName } from "@/components/approvals/approval-card";
import { UntrustedText } from "@/components/chat/untrusted-text";
import { QuestionAnswer } from "@/components/tasks/task-question";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { getInbox, type InboxTask } from "@/server/queries/inbox";
import { InboxTaskAction } from "./inbox-task-action";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("inbox");
  return { title: t("meta.title") };
}

/** Where a row was raised and how long it has waited, in one muted line. */
function Meta({ parts }: { parts: (React.ReactNode | null)[] }) {
  const shown = parts.filter(Boolean);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {shown.map((part, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          <span className="min-w-0 truncate">{part}</span>
        </span>
      ))}
    </div>
  );
}

const TASK_LINK = "font-medium text-foreground underline-offset-2 hover:underline";

export default async function InboxPage() {
  const [inbox, t, f] = await Promise.all([getInbox(), getTranslations("inbox"), getFormat()]);

  const taskRows = (rows: InboxTask[], kind: "task" | "blocked") =>
    rows.map((task) => (
      <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
        {task.agentName ? (
          <AgentAvatar avatar={task.agentAvatar} size="lg" />
        ) : (
          <SectionIcon icon={ListTodoIcon} className="bg-muted text-muted-foreground dark:bg-muted" />
        )}
        <div className="min-w-40 flex-1">
          <Link href={`/tasks/${task.id}`} title={task.title} className={cn(TASK_LINK, "block truncate text-sm")}>
            {task.title}
          </Link>
          <Meta parts={[task.agentName, task.projectName, f.relative(task.since)]} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {kind === "task" ? <PriorityBadge priority={task.priority} /> : <TaskStatusBadge status={task.status} />}
          <InboxTaskAction taskId={task.id} kind={kind} />
        </div>
      </li>
    ));

  return (
    <PageBody className="max-w-4xl">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <Button variant="outline" asChild>
            <Link href="/approvals?tab=history">
              <HistoryIcon />
              {t("page.approvalHistory")}
            </Link>
          </Button>
        }
      />

      {inbox.total === 0 && (
        <div className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
          <SectionIcon icon={InboxIcon} />
          <p className="min-w-0 text-sm text-muted-foreground">{t("page.empty")}</p>
        </div>
      )}

      {inbox.questions.length > 0 && (
        <SectionCard
          icon={CircleHelpIcon}
          title={t("sections.question")}
          count={inbox.questions.length}
          description={t("sections.questionDescription")}
          flush
        >
          <SectionList>
            {inbox.questions.map((q) => (
              <li key={q.id} id={`q-${q.id}`} className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  {q.askerName ? (
                    <AgentAvatar avatar={q.askerAvatar} size="lg" />
                  ) : (
                    <SectionIcon icon={BotIcon} className="bg-muted text-muted-foreground dark:bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {q.askerName ? t("question.from", { name: q.askerName }) : t("question.system")}
                    </div>
                    <Meta
                      parts={[
                        <Link key="task" href={`/tasks/${q.taskId}`} title={q.taskTitle} className={TASK_LINK}>
                          {q.taskTitle}
                        </Link>,
                        q.projectName,
                        f.relative(q.since),
                      ]}
                    />
                  </div>
                </div>
                <div className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
                  <UntrustedText text={q.body} />
                </div>
                <QuestionAnswer questionId={q.id} taskId={q.taskId} choices={q.options} />
              </li>
            ))}
          </SectionList>
        </SectionCard>
      )}

      {inbox.approvals.length > 0 && (
        <SectionCard icon={ShieldCheckIcon} title={t("sections.approval")} count={inbox.approvals.length} flush>
          <SectionList>
            {inbox.approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <AgentAvatar avatar={a.agentAvatar} size="lg" />
                <div className="min-w-40 flex-1">
                  <Link href={`/runs/${a.runId}`} className={cn(TASK_LINK, "block truncate text-sm")}>
                    {a.agentName}
                  </Link>
                  <Meta parts={[<ToolName key="tool" name={a.toolName} />, a.projectName, f.relative(a.since)]} />
                </div>
                <div className="ml-auto">
                  <ApprovalActions id={a.id} size="xs" approveVariant="outline" />
                </div>
              </li>
            ))}
          </SectionList>
        </SectionCard>
      )}

      {inbox.tasks.length > 0 && (
        <SectionCard icon={ListTodoIcon} title={t("sections.task")} count={inbox.tasks.length} flush>
          <SectionList>{taskRows(inbox.tasks, "task")}</SectionList>
        </SectionCard>
      )}

      {inbox.blocked.length > 0 && (
        <SectionCard
          icon={TriangleAlertIcon}
          title={t("sections.blocked")}
          count={inbox.blocked.length}
          description={t("sections.blockedDescription")}
          flush
        >
          <SectionList>{taskRows(inbox.blocked, "blocked")}</SectionList>
        </SectionCard>
      )}
    </PageBody>
  );
}

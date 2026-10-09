import {
  ArrowUpRight,
  ChevronDown,
  GitBranch,
  Info,
  ListTree,
  MessageSquareText,
  ShieldCheck,
  TextCursorInput,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AgentAvatar, AgentName } from "@/components/app/agent-avatar";
import { PageBody, PageHeader } from "@/components/app/page-header";
import {
  SectionCard,
  sectionCardClass,
  SectionEmpty,
  SectionIcon,
  SectionList,
  SectionRow,
} from "@/components/app/section-card";
import { RunStatusBadge } from "@/components/app/status-badge";
import { ChatMarkdown } from "@/components/chat/chat-parts";
import { UntrustedText } from "@/components/chat/untrusted-text";
import { ToolName } from "@/components/approvals/approval-card";
import { ApprovalActions } from "@/components/approvals/approval-actions";
import { ApprovalStatusBadge } from "@/components/approvals/approval-status-badge";
import { RunActions } from "@/components/runs/run-actions";
import { RunFailureAlert } from "@/components/runs/run-failure-alert";
import { RunsBackLink } from "@/components/runs/runs-back-link";
import { RunTimeline } from "@/components/runs/run-timeline";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getFormat } from "@/server/format";
import { getRunDetail } from "@/server/queries/runs";

export async function generateMetadata(props: PageProps<"/runs/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const t = await getTranslations("runs");
  return { title: t("meta.detailTitle", { id: id.slice(0, 8) }) };
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 lg:flex-row lg:items-baseline lg:justify-between lg:gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground lg:text-sm">{label}</dt>
      <dd className="tabular min-w-0 truncate text-sm font-medium lg:text-right">{children}</dd>
    </div>
  );
}

function LinkRow({ label, href, children }: { label: string; href: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <Link href={href} className="inline-flex min-w-0 items-center gap-1 font-medium underline-offset-2 hover:underline">
        <span className="truncate">{children}</span>
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      </Link>
    </div>
  );
}

export default async function RunDetailPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  const detail = await getRunDetail(id);
  if (!detail) notFound();
  const [t, tc, tAgent, fmt] = await Promise.all([
    getTranslations("runs.detail"),
    getTranslations("common"),
    getTranslations("runs.agentChip"),
    getFormat(),
  ]);
  const { run, agent, project, task, conversation, parent, children, events, approvals } = detail;
  const agentName = agent?.name ?? tAgent("deleted");
  const triggerKey = `trigger.${run.trigger}` as Parameters<typeof tc>[0];
  const active = run.status === "queued" || run.status === "running";
  const duration = fmt.duration(run.startedAt, run.finishedAt ?? (run.status === "running" ? new Date() : null));

  return (
    <PageBody>
      <RunsBackLink />
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-3">
            <AgentAvatar avatar={agent?.avatar} size="lg" className="size-9" />
            <span className="min-w-0 truncate" title={agentName}>
              {agentName}
            </span>
            <RunStatusBadge status={run.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{tc.has(triggerKey) ? tc(triggerKey) : run.trigger}</span>
            <span aria-hidden>·</span>
            <span>{t("createdAgo", { time: fmt.relative(run.createdAt) })}</span>
          </span>
        }
        actions={
          <RunActions
            id={run.id}
            canCancel={run.status === "queued" || run.status === "running" || run.status === "waiting_approval"}
            canRerun={run.status === "failed" && Boolean(run.conversationId)}
          />
        }
      />

      {(run.status === "failed" || run.status === "cancelled") && (
        <RunFailureAlert status={run.status} error={run.error} failureKind={run.failureKind} />
      )}

      {/* Mobile order: details, approvals, the run itself, child runs. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_auto_auto_1fr]">
        <div className="order-3 flex min-w-0 flex-col gap-6 lg:order-none lg:col-start-1 lg:row-span-4 lg:row-start-1">
          <Collapsible className={sectionCardClass}>
            <CollapsibleTrigger className="group/input flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:rounded-b-none sm:px-5">
              <SectionIcon icon={TextCursorInput} />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-base leading-snug font-semibold tracking-tight">{t("input.title")}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {run.input ? t("input.characters", { count: run.input.length }) : t("input.noPrompt")}
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/input:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
              <div className="p-4 sm:p-5">
                {run.input ? (
                  // A div, not a pre: external data inside the input renders as its own block.
                  <div className="max-h-96 overflow-auto rounded-lg border border-border/60 bg-muted/35 px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap dark:bg-muted/25">
                    <UntrustedText text={run.input} />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("input.fromConversation")}</p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          <SectionCard icon={MessageSquareText} title={t("output.title")}>
            {run.output ? (
              <ChatMarkdown className="text-sm leading-6">{run.output}</ChatMarkdown>
            ) : (
              <p className="text-sm text-muted-foreground">{active ? t("output.working") : t("output.none")}</p>
            )}
          </SectionCard>

          <SectionCard icon={ListTree} title={t("timeline.title")} count={events.length} flush={events.length === 0}>
            {events.length === 0 ? (
              <SectionEmpty>{active ? t("timeline.emptyActive") : t("timeline.emptyDone")}</SectionEmpty>
            ) : (
              <RunTimeline events={events} />
            )}
          </SectionCard>
        </div>

        <SectionCard icon={Info} title={t("details.title")} className="order-1 lg:order-none lg:col-start-2">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-1 lg:gap-y-2.5">
            <Stat label={t("stats.model")}>
              {run.model ? (
                <span className="font-mono text-xs" title={`${run.provider}/${run.model}`}>
                  {run.provider}/{run.model}
                </span>
              ) : (
                "-"
              )}
            </Stat>
            <Stat label={t("stats.steps")}>{run.steps}</Stat>
            <Stat label={t("stats.tokens")}>
              {fmt.tokens(run.inputTokens)} / {fmt.tokens(run.outputTokens)}
            </Stat>
            <Stat label={t("stats.cost")}>{fmt.usd(run.costUsd)}</Stat>
            <Stat label={t("stats.duration")}>{duration || "-"}</Stat>
            <Stat label={t("stats.started")}>{run.startedAt ? fmt.dateTime(run.startedAt) : "-"}</Stat>
          </dl>
          <div aria-hidden className="-mx-4 my-4 h-px bg-border/60 sm:-mx-5" />
          <div className="space-y-2.5">
            {agent && (
              <LinkRow label={t("links.agent")} href={`/agents/${agent.id}`}>
                {agent.name}
              </LinkRow>
            )}
            {project && (
              <LinkRow label={t("links.project")} href={`/projects/${project.id}`}>
                {project.name}
              </LinkRow>
            )}
            {task && (
              <LinkRow label={t("links.task")} href={`/tasks?task=${task.id}`}>
                {task.title}
              </LinkRow>
            )}
            {conversation && (
              <LinkRow label={t("links.conversation")} href={`/chat/${conversation.id}`}>
                {conversation.title || t("links.untitled")}
              </LinkRow>
            )}
            {parent && (
              <LinkRow label={t("links.parent")} href={`/runs/${parent.id}`}>
                <AgentName name={parent.agentName ?? tAgent("deleted")} avatar={parent.agentAvatar} />
              </LinkRow>
            )}
            {!project && !task && !conversation && !parent && (
              <p className="text-xs text-muted-foreground">{t("links.none")}</p>
            )}
          </div>
        </SectionCard>

        {approvals.length > 0 && (
          <SectionCard
            icon={ShieldCheck}
            title={t("approvals")}
            count={approvals.length}
            flush
            className="order-2 lg:order-none lg:col-start-2"
          >
            <SectionList>
              {approvals.map((a) => (
                <li key={a.id} className="space-y-2 px-4 py-3 sm:px-5">
                  <div className="flex min-w-0 text-sm">
                    <ToolName name={a.toolName} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <ApprovalStatusBadge status={a.status} />
                    {a.decidedAt
                      ? t("approvalDecided", { time: fmt.relative(a.decidedAt) })
                      : t("approvalRequested", { time: fmt.relative(a.createdAt) })}
                  </div>
                  {a.status === "pending" && (
                    <div className="pt-1">
                      <ApprovalActions id={a.id} />
                    </div>
                  )}
                </li>
              ))}
            </SectionList>
          </SectionCard>
        )}

        {children.length > 0 && (
          <SectionCard
            icon={GitBranch}
            title={t("children")}
            count={children.length}
            flush
            className="order-4 lg:order-none lg:col-start-2"
          >
            <SectionList>
              {children.map((c) => (
                <SectionRow
                  key={c.id}
                  href={`/runs/${c.id}`}
                  media={<AgentAvatar avatar={c.agentAvatar} size="md" />}
                  title={c.agentName ?? tAgent("deleted")}
                  subtitle={<span className="tabular">{fmt.usd(c.costUsd)}</span>}
                  trailing={<RunStatusBadge status={c.status} />}
                  className="py-2.5"
                />
              ))}
            </SectionList>
          </SectionCard>
        )}
      </div>
    </PageBody>
  );
}

import { ActivityIcon, CoinsIcon, ListTodoIcon, type LucideIcon, PlayIcon, TargetIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import {
  SectionCard,
  sectionCardClass,
  SectionEmpty,
  SectionEmptyLink,
  SectionIcon,
  SectionList,
  SectionRow,
} from "@/components/app/section-card";
import { PreviewList } from "@/components/previews/preview-list";
import { RunStatusBadge, SETTABLE_TASK_STATUSES, TASK_STATUSES, TaskStatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import type { PreviewRow } from "@/server/queries/previews";
import type { getProjectOverview, ProjectDetail, ProjectTeam } from "@/server/queries/projects";
import { ManagerBadge } from "./team-parts";

type Overview = Awaited<ReturnType<typeof getProjectOverview>>;

export async function ProjectOverview({
  project,
  overview,
  team,
  previews,
}: {
  project: ProjectDetail;
  overview: Overview;
  team: ProjectTeam;
  /** The project's live previews: their card shows only when there are some. */
  previews: PreviewRow[];
}) {
  const [t, tc, tAgent, fmt] = await Promise.all([
    getTranslations("projects.overview"),
    getTranslations("common"),
    getTranslations("runs.agentChip"),
    getFormat(),
  ]);
  const triggerLabel = (trigger: string) => {
    const key = `trigger.${trigger}` as Parameters<typeof tc>[0];
    return tc.has(key) ? tc(key) : trigger;
  };
  const budget = project.budgetUsd;
  const over = budget !== null && overview.monthSpend > budget;
  const totalTasks = Object.values(overview.tasksByStatus).reduce((a, b) => a + b, 0);
  const tasksHref = `/projects/${project.id}?tab=tasks`;
  const settingsHref = `/projects/${project.id}/settings`;
  const teamHref = `/projects/${project.id}?tab=team`;
  // The manager leads the list.
  const members = team.manager ? [team.manager, ...team.specialists] : team.specialists;
  const link = (href: string) =>
    function RichLink(chunks: React.ReactNode) {
      return <SectionEmptyLink href={href}>{chunks}</SectionEmptyLink>;
    };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat
            icon={ListTodoIcon}
            label={t("tasks")}
            value={String(totalTasks)}
            hint={t("tasksDone", { count: overview.tasksByStatus.done ?? 0 })}
          />
          <Stat
            icon={CoinsIcon}
            label={t("monthSpend")}
            value={fmt.usd(overview.monthSpend)}
            hint={budget !== null ? t("ofBudget", { budget: fmt.usd(budget) }) : t("noBudget")}
            danger={over}
            className="order-last col-span-2 sm:order-none sm:col-span-1"
          >
            {budget !== null && (
              <Progress
                value={budget ? Math.min(100, (overview.monthSpend / budget) * 100) : 100}
                className={cn("h-1.5", over && "[&>[data-slot=progress-indicator]]:bg-destructive")}
              />
            )}
          </Stat>
          <Stat icon={PlayIcon} label={t("runsWeek")} value={String(overview.runsLastWeek)} />
        </div>

        <SectionCard
          icon={ListTodoIcon}
          title={t("byStatus")}
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link href={tasksHref}>{tc("actions.viewAll")}</Link>
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            {/* Paused and cancelled only when the project has such tasks: most never do. */}
            {TASK_STATUSES.filter(
              (s) => (SETTABLE_TASK_STATUSES as readonly string[]).includes(s) || overview.tasksByStatus[s],
            ).map((s) => (
              <Link
                key={s}
                href={tasksHref}
                className="flex min-w-0 flex-row-reverse items-center justify-between gap-1.5 rounded-xl border border-border/60 px-3 py-2 sm:flex-col sm:items-start sm:py-2.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span
                  className={cn(
                    "tabular text-base font-semibold tracking-tight sm:text-xl",
                    !overview.tasksByStatus[s] && "text-muted-foreground/60",
                  )}
                >
                  {overview.tasksByStatus[s] ?? 0}
                </span>
                <TaskStatusBadge status={s} />
              </Link>
            ))}
          </div>
        </SectionCard>

        {previews.length > 0 && <PreviewList previews={previews} showOwner={false} variant="card" />}

        <SectionCard
          icon={ActivityIcon}
          title={t("recentRuns")}
          flush
          action={
            overview.recentRuns.length > 0 && (
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs?project=${project.id}`}>{tc("actions.viewAll")}</Link>
              </Button>
            )
          }
        >
          {overview.recentRuns.length ? (
            <SectionList>
              {overview.recentRuns.map((r) => {
                const agentName = r.agentName ?? tAgent("deleted");
                return (
                  <SectionRow
                    key={r.id}
                    href={`/runs/${r.id}`}
                    media={<AgentAvatar avatar={r.agentAvatar} size="lg" />}
                    title={<span title={r.input || agentName}>{r.input || agentName}</span>}
                    subtitle={`${agentName} · ${triggerLabel(r.trigger)} · ${fmt.relative(r.createdAt)}`}
                    trailing={
                      <>
                        <span className="tabular hidden text-xs text-muted-foreground sm:inline">{fmt.usd(r.costUsd)}</span>
                        <RunStatusBadge status={r.status} />
                      </>
                    }
                  />
                );
              })}
            </SectionList>
          ) : (
            <SectionEmpty>{t("noRuns")}</SectionEmpty>
          )}
        </SectionCard>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <SectionCard icon={TargetIcon} title={t("goals")} flush={!project.goals}>
          {project.goals ? (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{project.goals}</p>
          ) : (
            <SectionEmpty>{t.rich("noGoals", { link: link(settingsHref) })}</SectionEmpty>
          )}
        </SectionCard>

        <SectionCard
          icon={UsersIcon}
          title={t("team")}
          count={members.length}
          flush
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link href={teamHref}>{t("manageTeam")}</Link>
            </Button>
          }
        >
          {members.length ? (
            <SectionList>
              {members.map((a) => (
                <SectionRow
                  key={a.id}
                  href={`/agents/${a.id}`}
                  media={<AgentAvatar avatar={a.avatar} size="lg" className={cn(!a.enabled && "opacity-60")} />}
                  title={
                    <span className={cn(!a.enabled && "text-muted-foreground")} title={a.name}>
                      {a.name}
                    </span>
                  }
                  subtitle={a.enabled ? a.role || t("noRole") : tc("states.disabled")}
                  trailing={a.id === team.manager?.id && <ManagerBadge />}
                />
              ))}
            </SectionList>
          ) : null}
          {!team.manager && <SectionEmpty>{t.rich("noManager", { link: link(teamHref) })}</SectionEmpty>}
        </SectionCard>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  danger,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn(sectionCardClass, "flex min-w-0 flex-col gap-3 p-4 sm:p-5", className)}>
      <div className="flex items-center gap-2.5">
        <SectionIcon icon={icon} className="size-7 rounded-md" />
        <p className="min-w-0 truncate text-sm text-muted-foreground">{label}</p>
      </div>
      <div className="space-y-0.5">
        <p className={cn("tabular text-2xl font-semibold tracking-tight", danger && "text-destructive")}>{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

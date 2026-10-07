import { BotIcon, ChartColumnIcon, ShieldCheckIcon, SquareKanbanIcon, WalletIcon } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionCard, SectionEmpty } from "@/components/app/section-card";
import { CostChart } from "@/components/costs/cost-chart";
import { AttentionTasksCard } from "@/components/dashboard/attention-tasks-card";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { PendingApprovalsCard } from "@/components/dashboard/pending-approvals-card";
import { RecentRunsCard } from "@/components/dashboard/recent-runs-card";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { getDashboard } from "@/server/queries/dashboard";
import { requireUser } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("items.dashboard") };
}

function greetingKey(hour: number) {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

async function CostDelta({ current, previous }: { current: number; previous: number }) {
  const [t, f] = await Promise.all([getTranslations("dashboard.kpi"), getFormat()]);
  if (previous <= 0) return <>{t("lastMonth", { amount: f.usd(previous) })}</>;
  const delta = ((current - previous) / previous) * 100;
  const up = delta > 0;
  return (
    <>
      {t.rich("vsLastMonth", {
        delta: `${up ? "+" : ""}${Math.round(delta)}%`,
        amount: f.usd(previous),
        highlight: (chunks) => (
          <span className={cn("tabular font-medium", up ? "text-destructive" : "text-success")}>{chunks}</span>
        ),
      })}
    </>
  );
}

function TaskCount({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {label}
      <span className="tabular font-medium text-foreground">{value}</span>
    </span>
  );
}

export default async function DashboardPage() {
  const [user, data, t, f] = await Promise.all([requireUser(), getDashboard(), getTranslations("dashboard"), getFormat()]);
  const now = new Date();
  const firstName = user.name?.trim().split(/\s+/)[0] || "";
  const greeting = t(`greeting.${greetingKey(now.getHours())}`);
  const today = f.date(now, "EEEE, d MMMM yyyy");
  const openTasks = data.tasks.in_progress + data.tasks.blocked + data.tasks.review;
  const { onboarding } = data;

  return (
    <PageBody>
      <PageHeader
        title={firstName ? t("greeting.withName", { greeting, name: firstName }) : greeting}
        description={today.charAt(0).toUpperCase() + today.slice(1)}
      />

      {(!onboarding.hasKeys || !onboarding.hasAgents) && <OnboardingCard state={onboarding} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard
          label={t("kpi.pendingApprovals")}
          value={data.approvals.count}
          icon={ShieldCheckIcon}
          href="/approvals"
          tone={data.approvals.count > 0 ? "warning" : "default"}
        >
          {data.approvals.count > 0 ? t("kpi.awaitingDecision") : t("kpi.nothingToApprove")}
        </KpiCard>
        <KpiCard label={t("kpi.openTasks")} value={openTasks} icon={SquareKanbanIcon} href="/tasks">
          <span className="flex flex-wrap gap-x-2.5 gap-y-1">
            <TaskCount tone="bg-primary" label={t("kpi.inProgress")} value={data.tasks.in_progress} />
            <TaskCount tone="bg-destructive" label={t("kpi.blocked")} value={data.tasks.blocked} />
            <TaskCount tone="bg-warning" label={t("kpi.review")} value={data.tasks.review} />
          </span>
        </KpiCard>
        <KpiCard label={t("kpi.activeAgents")} value={data.active.agents} icon={BotIcon} href="/runs?status=running">
          {data.active.runs ? t("kpi.activeRuns", { count: data.active.runs }) : t("kpi.idle")}
        </KpiCard>
        <KpiCard label={t("kpi.monthCost")} value={f.usd(data.costs.current)} icon={WalletIcon} href="/costs">
          <CostDelta current={data.costs.current} previous={data.costs.previous} />
        </KpiCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PendingApprovalsCard approvals={data.approvals.list} total={data.approvals.count} />
        <AttentionTasksCard tasks={data.attention} total={data.tasks.blocked + data.tasks.review} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <RecentRunsCard runs={data.recentRuns} className="lg:col-span-3" />
        <SectionCard
          icon={ChartColumnIcon}
          title={t("dailyCost.title")}
          description={t("dailyCost.description")}
          flush={data.daily.series.length === 0}
          className="lg:col-span-2"
        >
          {data.daily.series.length === 0 ? (
            <SectionEmpty>{t("dailyCost.empty")}</SectionEmpty>
          ) : (
            <CostChart points={data.daily.points} series={data.daily.series} className="h-56" />
          )}
        </SectionCard>
      </div>
    </PageBody>
  );
}

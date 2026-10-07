import { Activity, ArrowDownToLine, ArrowUpFromLine, Bot, ChartColumn, Cog, Cpu, FolderKanban, Wallet } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionCard, SectionEmpty } from "@/components/app/section-card";
import { BudgetUsage } from "@/components/costs/budget-usage";
import { CostBreakdownTable, type BreakdownRow } from "@/components/costs/cost-breakdown-table";
import { CostChart } from "@/components/costs/cost-chart";
import { CostKpi } from "@/components/costs/cost-kpi";
import { CostPeriodSelect } from "@/components/costs/cost-period-select";
import { AgentChip } from "@/components/runs/agent-chip";
import { getFormat } from "@/server/format";
import { getCostReport } from "@/server/queries/costs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("costs");
  return { title: t("meta.title") };
}

const PERIODS = [7, 30, 90];

export default async function CostsPage(props: PageProps<"/costs">) {
  const sp = await props.searchParams;
  const requested = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days = PERIODS.includes(requested) ? requested : 30;
  const [report, t, fmt] = await Promise.all([getCostReport(days), getTranslations("costs"), getFormat()]);
  const { total } = report;

  const agentRows: BreakdownRow[] = report.byAgent.map((r) => ({
    key: r.agentId ?? "deleted",
    label: <AgentChip name={r.name} avatar={r.avatar} />,
    ...r,
  }));
  if (report.system) {
    agentRows.push({
      key: "system",
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Cog className="size-4 text-muted-foreground" />
          </span>
          <span className="truncate font-medium">{t("breakdown.systemJobs")}</span>
        </span>
      ),
      ...report.system,
    });
    agentRows.sort((a, b) => b.cost - a.cost);
  }

  const projectRows: BreakdownRow[] = report.byProject.map((r) => ({
    key: r.projectId ?? "none",
    label: r.name ? (
      <span className="truncate font-medium" title={r.name}>
        {r.name}
      </span>
    ) : (
      <span className="text-muted-foreground">{t("breakdown.noProject")}</span>
    ),
    ...r,
  }));

  const modelRows: BreakdownRow[] = report.byModel.map((r) => ({
    key: `${r.provider}/${r.model}`,
    label: r.model ? (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-mono text-xs" title={r.model}>
          {r.model}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{r.provider}</span>
      </span>
    ) : (
      <span className="text-muted-foreground" title={t("breakdown.noModelHint")}>
        {t("breakdown.noModel")}
      </span>
    ),
    ...r,
  }));

  return (
    <PageBody>
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <Suspense>
            <CostPeriodSelect value={days} />
          </Suspense>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <CostKpi icon={Wallet} label={t("totals.cost", { days })} value={fmt.usd(total.cost)} />
        <CostKpi
          icon={Activity}
          label={t("totals.runs")}
          value={String(total.runs)}
          hint={total.runs ? t("totals.average", { cost: fmt.usd(total.cost / total.runs) }) : undefined}
        />
        <CostKpi icon={ArrowDownToLine} label={t("totals.inputTokens")} value={fmt.tokens(total.inputTokens)} />
        <CostKpi icon={ArrowUpFromLine} label={t("totals.outputTokens")} value={fmt.tokens(total.outputTokens)} />
      </div>

      <SectionCard
        icon={ChartColumn}
        title={t("daily.title")}
        description={t("daily.description", { days })}
        flush={report.daily.series.length === 0}
      >
        {report.daily.series.length === 0 ? (
          <SectionEmpty>{t("daily.empty")}</SectionEmpty>
        ) : (
          <CostChart points={report.daily.points} series={report.daily.series} />
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CostBreakdownTable
          icon={Bot}
          title={t("breakdown.byAgent")}
          firstColumn={t("breakdown.agent")}
          rows={agentRows}
          total={total.cost}
        />
        <CostBreakdownTable
          icon={FolderKanban}
          title={t("breakdown.byProject")}
          firstColumn={t("breakdown.project")}
          rows={projectRows}
          total={total.cost}
        />
        <CostBreakdownTable
          icon={Cpu}
          title={t("breakdown.byModel")}
          firstColumn={t("breakdown.model")}
          rows={modelRows}
          total={total.cost}
        />
        <BudgetUsage budgets={report.budgets} />
      </div>
    </PageBody>
  );
}

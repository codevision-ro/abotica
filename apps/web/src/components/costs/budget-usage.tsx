import { Gauge } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionEmpty, SectionList } from "@/components/app/section-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";

type Spend = { budgetUsd: number; spent: number };
type ProjectBudget = Spend & { id: string; name: string };

/** One budget: its name linking to where it is set, the spend against it and a progress line. */
async function BudgetUsageRow({ name, href, budget }: { name: string; href: string; budget: Spend }) {
  const [t, fmt] = await Promise.all([getTranslations("costs.budgets"), getFormat()]);
  const pct = budget.budgetUsd > 0 ? (budget.spent / budget.budgetUsd) * 100 : 100;
  const danger = pct > 90;
  return (
    <li className="space-y-2 px-4 py-3.5 sm:px-5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <Link href={href} className="min-w-0 truncate font-medium underline-offset-2 hover:underline" title={name}>
          {name}
        </Link>
        <span className="tabular shrink-0 text-muted-foreground">
          <span className={cn("font-medium text-foreground", danger && "text-destructive")}>{fmt.usd(budget.spent)}</span> /{" "}
          {fmt.usd(budget.budgetUsd)}
          <span className={cn("ml-2 text-xs", danger && "text-destructive")}>{Math.round(pct)}%</span>
        </span>
      </div>
      <Progress
        value={Math.min(100, pct)}
        aria-label={t("progressLabel", { name })}
        className={cn("h-1.5", danger && "bg-destructive/15 [&>[data-slot=progress-indicator]]:bg-destructive")}
      />
    </li>
  );
}

/** This month's spend against the global budget from Settings > General and each project's own. */
export async function BudgetUsage({ budgets }: { budgets: { global: Spend | null; projects: ProjectBudget[] } }) {
  const t = await getTranslations("costs.budgets");
  return (
    <SectionCard icon={Gauge} title={t("title")} description={t("description")} flush>
      {!budgets.global && budgets.projects.length === 0 ? (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      ) : (
        <SectionList>
          {budgets.global && <BudgetUsageRow name={t("global")} href="/settings/general" budget={budgets.global} />}
          {budgets.projects.map((b) => (
            <BudgetUsageRow key={b.id} name={b.name} href={`/projects/${b.id}`} budget={b} />
          ))}
        </SectionList>
      )}
    </SectionCard>
  );
}

import { Pin } from "lucide-react";
import { useTranslations } from "next-intl";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type PinnedUsage = { count: number; usedTokens: number; omitted: number; budgetTokens: number };

/**
 * How much of the pinned budget (Settings > General) pinned entries take in every run, and how many do
 * not fit. `withGlobal` on an agent's or a project's memory, whose runs also get the global ones.
 */
export function PinnedBudget({
  usage,
  withGlobal = false,
  className,
}: {
  usage: PinnedUsage;
  withGlobal?: boolean;
  className?: string;
}) {
  const t = useTranslations("memory.budget");
  const full = usage.omitted > 0;
  const percent = usage.budgetTokens > 0 ? Math.min(100, (usage.usedTokens / usage.budgetTokens) * 100) : 100;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className="flex items-start gap-2 text-sm text-pretty text-muted-foreground">
        <Pin aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {t(withGlobal ? "pinnedUsageWithGlobal" : "pinnedUsage", {
            used: usage.usedTokens,
            budget: usage.budgetTokens,
          })}
          {full && <span className="text-warning"> {t("pinnedOmitted", { count: usage.omitted })}</span>}
        </span>
      </p>
      <Progress
        value={percent}
        aria-label={t("label")}
        className={cn("h-1.5", full && "bg-warning/15 [&>[data-slot=progress-indicator]]:bg-warning")}
      />
    </div>
  );
}

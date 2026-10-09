"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { COST_PERIODS } from "@/lib/cost-periods";

export function CostPeriodSelect({ value }: { value: number }) {
  const t = useTranslations("costs.period");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0.5}
      className="rounded-lg bg-muted p-[3px]"
      value={String(value)}
      aria-label={t("label")}
      onValueChange={(next) => {
        if (!next) return;
        const params = new URLSearchParams(searchParams);
        params.set("days", next);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }}
    >
      {COST_PERIODS.map((d) => (
        <ToggleGroupItem
          key={d}
          value={String(d)}
          className="rounded-md! px-3 text-muted-foreground hover:bg-transparent data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/40"
        >
          {t("days", { days: d })}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

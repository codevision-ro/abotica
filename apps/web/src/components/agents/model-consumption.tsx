"use client";

import type { ModelConsumption } from "@abotica/core";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const LEVELS = [1, 2, 3, 4, 5] as const;

/** How much a model consumes: five dots filled up to its level, then its class (fast, balanced, powerful). */
export function ModelConsumptionMeter({ consumption, className }: { consumption: ModelConsumption; className?: string }) {
  const t = useTranslations("agents.model");
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
      title={t("consumptionLevel", { level: consumption.level })}
    >
      <span className="flex items-center gap-0.5" aria-hidden>
        {LEVELS.map((level) => (
          <span
            key={level}
            className={cn("size-1.5 rounded-full", level <= consumption.level ? "bg-primary/80" : "bg-muted-foreground/25")}
          />
        ))}
      </span>
      <span className="sr-only">{t("consumptionLevel", { level: consumption.level })}</span>
      {t(`class.${consumption.class}`)}
    </span>
  );
}

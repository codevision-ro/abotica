"use client";

import { Gauge } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { SectionCard, SectionEmpty } from "@/components/app/section-card";
import { ModelConsumptionMeter } from "@/components/agents/model-consumption";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import type { ModelRatingRow, ModelRatings as ModelRatingsData } from "@/server/queries/models";
import { ProviderIcon } from "./provider-icon";

/** The columns of a row once the card is wide enough; narrower, the values stack under the model with labels. */
const COLUMNS = "@2xl:grid @2xl:grid-cols-[minmax(0,1fr)_8.5rem_7.5rem_4.5rem_9rem] @2xl:items-center @2xl:gap-3";

const percent = (rate: number) => Math.round(rate * 100);

/**
 * The models with what they consume, how they did on our runs and where they fit. Starts on the models
 * in use (every model when none is), with a switch to every available one.
 */
export function ModelRatings({ models, windowDays, minSuccessRate }: ModelRatingsData) {
  const t = useTranslations("settings.modelRatings");
  const switchId = useId();
  const inUse = models.filter((m) => m.inUse);
  const [showAll, setShowAll] = useState(inUse.length === 0);
  const visible = showAll ? models : inUse;

  return (
    <SectionCard
      icon={Gauge}
      title={t("title")}
      description={t("description", { days: windowDays })}
      action={
        <label htmlFor={switchId} className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch id={switchId} size="sm" checked={showAll} onCheckedChange={setShowAll} />
          {t("showAll")}
        </label>
      }
      flush
    >
      <div className="@container">
        {visible.length === 0 ? (
          <SectionEmpty>{t("empty")}</SectionEmpty>
        ) : (
          <>
            <div
              aria-hidden
              className={cn(
                "hidden border-b border-border/60 bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground sm:px-5",
                COLUMNS,
              )}
            >
              <span>{t("model")}</span>
              <span>{t("consumption")}</span>
              <span>{t("performance")}</span>
              <span className="text-right">{t("tokens")}</span>
              <span>{t("recommended")}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {visible.map((row) => (
                <ModelRatingItem key={row.key} row={row} minSuccessRate={minSuccessRate} />
              ))}
            </ul>
          </>
        )}
      </div>
    </SectionCard>
  );
}

/** One value of a row; its label shows only while the values stack (the header names the columns otherwise). */
function Cell({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <div className="text-xs text-muted-foreground @2xl:sr-only">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function ModelRatingItem({ row, minSuccessRate }: { row: ModelRatingRow; minSuccessRate: number }) {
  const t = useTranslations("settings.modelRatings");
  const format = useFormat();
  const { rating } = row;
  return (
    <li className={cn("flex flex-col gap-3 px-4 py-3 sm:px-5", COLUMNS)}>
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon provider={row.provider} size="xs" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={row.name}>
            {row.name}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={row.id}>
            {row.providerLabel} · <span className="font-mono">{row.id}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 @2xl:contents">
        <Cell label={t("consumption")}>
          {rating.consumption ? (
            <ModelConsumptionMeter consumption={rating.consumption} className="text-sm text-foreground" />
          ) : (
            <span className="text-muted-foreground">{row.connection === "local" ? t("local") : t("unknown")}</span>
          )}
        </Cell>
        <Cell label={t("performance")}>
          {rating.successRate === null ? (
            <span className="text-muted-foreground">{t("notEnoughData")}</span>
          ) : (
            <span className={cn("tabular", rating.withdrawn && "text-destructive")}>
              {t("successRate", { rate: percent(rating.successRate), count: rating.runs })}
            </span>
          )}
        </Cell>
        <Cell label={t("tokens")} className="@2xl:text-right">
          <span className={cn("tabular", rating.avgTokens === null && "text-muted-foreground")}>
            {rating.avgTokens === null ? "-" : format.tokens(rating.avgTokens)}
          </span>
        </Cell>
        <Cell label={t("recommended")}>
          {rating.withdrawn && rating.successRate !== null ? (
            <span className="text-xs text-pretty text-destructive">
              {t("withdrawn", { rate: percent(rating.successRate), min: percent(minSuccessRate) })}
            </span>
          ) : rating.recommendedFor.length ? (
            <span className="flex flex-wrap gap-1">
              {rating.recommendedFor.map((use) => (
                <Badge key={use} variant={use === "demanding" ? "outline" : "secondary"} className="font-normal">
                  {t(`uses.${use}`)}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </Cell>
      </div>
    </li>
  );
}

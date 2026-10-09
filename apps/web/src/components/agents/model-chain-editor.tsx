"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentFormOptions } from "@/server/queries/agents";
import { ModelPicker } from "./model-picker";

export type ModelRef = { provider: string; model: string };

/** Ordered provider/model rows with reorder and remove; optionally labels the first row as primary. */
export function ModelChainEditor({
  value,
  onChange,
  options,
  primaryFirst = false,
  addLabel,
}: {
  value: ModelRef[];
  onChange: (next: ModelRef[]) => void;
  options: Pick<AgentFormOptions, "providers" | "models">;
  primaryFirst?: boolean;
  addLabel?: string;
}) {
  const t = useTranslations("agents.chain");
  const update = (i: number, patch: Partial<ModelRef>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...value];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const firstConfigured = options.providers.find((p) => p.configured)?.id ?? options.providers[0]?.id ?? "";

  return (
    <div className="flex flex-col gap-2">
      {value.map((m, i) => (
        <div
          key={i}
          // On a phone: the label and the actions on top, then the provider and the model each on a full line.
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border p-2 sm:grid-cols-[auto_11rem_minmax(0,1fr)_auto]"
        >
          {/* Fixed-width label column so provider selects line up across rows. */}
          <span className={cn("flex shrink-0 max-sm:justify-start sm:justify-center", primaryFirst ? "sm:w-18" : "sm:w-6")}>
            {primaryFirst && i === 0 ? (
              <Badge variant="secondary">{t("primary")}</Badge>
            ) : (
              <span className="tabular text-xs text-muted-foreground">
                {primaryFirst ? t("fallback", { n: i }) : `${i + 1}.`}
              </span>
            )}
          </span>
          <Select value={m.provider} onValueChange={(p) => update(i, { provider: p, model: "" })}>
            <SelectTrigger
              className="w-full min-w-0 max-sm:col-span-full max-sm:row-start-2"
              aria-label={t("provider", { n: i + 1 })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.providers.map((p) => (
                <SelectItem key={p.id} value={p.id} disabled={!p.configured}>
                  {p.label}
                  {!p.configured && <span className="text-xs text-muted-foreground">{t("noKey")}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ModelPicker
            provider={m.provider}
            value={m.model}
            onChange={(model) => update(i, { model })}
            models={options.models}
            className="max-sm:col-span-full max-sm:row-start-3"
          />
          <div className="flex gap-1 max-sm:col-start-3 max-sm:row-start-1 max-sm:justify-self-end">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveUp")}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveDown")}
              disabled={i === value.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("remove")}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...value, { provider: firstConfigured, model: "" }])}
      >
        <PlusIcon /> {addLabel ?? t("addFallback")}
      </Button>
    </div>
  );
}

export const chainLabel = (chain: ModelRef[]) => chain.map((m) => `${m.provider}/${m.model}`).join(" → ");

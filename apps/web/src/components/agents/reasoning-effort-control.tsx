"use client";

import { effortOptions, type ReasoningEffort, type ReasoningSupport, resolveEffort } from "@abotica/core/models/reasoning";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** Thumb width in px: Radix keeps the thumb inside the track, so the end stops sit half a thumb in. */
const THUMB_PX = 16;

/** Where stop `i` of `n` sits along the track, matching the thumb's position. */
const stopLeft = (i: number, n: number) => {
  const p = i / (n - 1);
  return `calc(${p * 100}% + ${(0.5 - p) * THUMB_PX}px)`;
};

/** What applies while the switch is on. */
export type InheritedEffort = {
  /** "default" means the model decides. */
  effort: ReasoningEffort;
  /** Where the effort comes from (e.g. "Settings"), shown as "Default (Settings: High)". */
  source?: string;
};

/**
 * Reasoning effort as a stepped slider over the efforts the model accepts, with a "Default" switch
 * that follows `inherited`. A stored effort the model does not offer is kept as is: the thumb shows
 * where it resolves and a hint says so.
 */
export function ReasoningEffortControl({
  value,
  onChange,
  support,
  modelName,
  inherited,
  size = "default",
  className,
  children,
}: {
  /** null or "default": follow `inherited`. */
  value: ReasoningEffort | null;
  /** Receives null when the switch is turned on. */
  onChange: (value: ReasoningEffort | null) => void;
  /** The model's support: null when it does not reason, undefined when it is not in the catalog. */
  support: ReasoningSupport | null | undefined;
  modelName: string;
  inherited: InheritedEffort;
  size?: "sm" | "default";
  className?: string;
  /** Extra notes under the control. */
  children?: React.ReactNode;
}) {
  const t = useTranslations("agents.effort");
  const labelId = useId();
  const label = (effort: ReasoningEffort) => t(`options.${effort}.label`);

  const stops: ReasoningEffort[] = effortOptions(support).filter((effort) => effort !== "default");
  const inheriting = value === null || value === "default";
  const effort = inheriting ? inherited.effort : value;
  const resolved = resolveEffort(effort, support);
  // -1 when the model decides: there is no stop to show.
  const index = stops.indexOf(resolved);
  const slider = stops.length > 1;
  const shown = index >= 0 ? stops[index]! : "default";

  // Turning the switch off starts where the inherited effort put the thumb; nearest to medium otherwise.
  const start = [resolved, resolveEffort("medium", support)].find((e) => stops.includes(e)) ?? stops[0];
  const note = (text: string) => (
    <FieldDescription className={cn("flex items-center gap-1.5", size === "sm" && "text-[11px] leading-snug")}>
      <InfoIcon className="size-3.5 shrink-0" aria-hidden />
      {text}
    </FieldDescription>
  );

  return (
    <Field className={cn("@container/effort gap-2.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <FieldTitle id={labelId} className={cn(size === "sm" && "text-xs")}>
          {t("label")}
        </FieldTitle>
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {/* Without a stop there is nothing to pin: the switch can only go back to the default. */}
          <Switch
            size="sm"
            checked={inheriting}
            disabled={inheriting && !start}
            onCheckedChange={(on) => onChange(on ? null : (start ?? null))}
          />
          <span className="truncate">
            {inherited.effort === "default"
              ? t("inheritModel")
              : t("inheritFrom", { source: inherited.source ?? "", effort: label(inherited.effort) })}
          </span>
        </label>
      </div>

      {slider && (
        <div className="flex flex-col gap-2">
          <Slider
            min={0}
            max={stops.length - 1}
            step={1}
            value={[Math.max(index, 0)]}
            onValueChange={([i]) => i !== undefined && onChange(stops[i]!)}
            disabled={inheriting}
            thumbProps={{ "aria-labelledby": labelId, "aria-valuetext": label(shown) }}
            // The model decides: no position to show.
            className={cn(index < 0 && "**:data-[slot=slider-range]:hidden **:data-[slot=slider-thumb]:hidden")}
          />
          <div aria-hidden className={cn("relative h-1 @lg/effort:h-4", inheriting && "opacity-50")}>
            {stops.map((stop, i) => {
              const edge = i === 0 ? "left-0" : i === stops.length - 1 ? "right-0" : "-translate-x-1/2";
              return (
                <span key={stop}>
                  {/* Narrow: a tick per stop; the selected label is in the hint line. */}
                  <span
                    className="absolute top-0 size-1 -translate-x-1/2 rounded-full bg-muted-foreground/40 @lg/effort:hidden"
                    style={{ left: stopLeft(i, stops.length) }}
                  />
                  <span
                    className={cn(
                      "absolute top-0 hidden text-[11px] leading-4 whitespace-nowrap @lg/effort:block",
                      i === index ? "font-medium text-foreground" : "text-muted-foreground",
                      edge,
                    )}
                    style={i === 0 || i === stops.length - 1 ? undefined : { left: stopLeft(i, stops.length) }}
                  >
                    {label(stop)}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {stops.length > 0 && (
        <FieldDescription className={cn(size === "sm" && "text-[11px] leading-snug")}>
          <span className={cn("font-medium text-foreground", slider && "@lg/effort:hidden")}>{label(shown)} · </span>
          {t(`options.${shown}.hint`)}
        </FieldDescription>
      )}
      {support === null && note(t("unsupported", { model: modelName }))}
      {support && stops.length === 0 && note(t("alwaysOn", { model: modelName }))}
      {stops.length > 0 &&
        effort !== "default" &&
        !stops.includes(effort) &&
        note(
          t("fallback", {
            model: modelName,
            effort: label(effort),
            resolved: resolved === "default" ? t("modelDefault") : label(resolved),
          }),
        )}
      {children}
    </Field>
  );
}

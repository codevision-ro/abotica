"use client";

import { effortOptions, type ReasoningEffort, type ReasoningSupport, resolveEffort } from "@abotica/core/models/reasoning";
import { InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { Field, FieldDescription, FieldTitle } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/** What applies while the control is on "Default". */
export type InheritedEffort = {
  /** "default" means the model decides. */
  effort: ReasoningEffort;
  /** Where the effort comes from (e.g. "Settings"), shown as "Default: High, from Settings". */
  source?: string;
};

/** An effort with its own segment. */
type Stop = Exclude<ReasoningEffort, "default">;

/** The toggle group value of the "Default" segment. */
const DEFAULT = "default";

/**
 * Reasoning effort as a segmented control: "Default" (follows `inherited`) and one segment per effort
 * the model accepts. A stored effort the model does not offer is kept as is: the segment it resolves
 * to is selected and a note says so.
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
  /** Receives null when "Default" is picked. */
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

  const stops = effortOptions(support).filter((effort): effort is Stop => effort !== "default");
  const inheriting = value === null || value === "default";
  const effort = inheriting ? inherited.effort : value;
  const resolved = resolveEffort(effort, support);
  // "default" when the model decides: no segment shows where the effort lands.
  const shown = stops.find((stop) => stop === resolved) ?? "default";

  const defaultLine =
    inherited.effort === "default"
      ? t("defaultModel")
      : inherited.source
        ? t("defaultFrom", { effort: label(inherited.effort), source: inherited.source })
        : t("defaultEffort", { effort: label(inherited.effort) });
  const textSize = size === "sm" && "text-[11px] leading-snug";
  const note = (text: string) => (
    <FieldDescription className={cn("flex items-center gap-1.5", textSize)}>
      <InfoIcon className="size-3.5 shrink-0" aria-hidden />
      {text}
    </FieldDescription>
  );
  const segment = cn(
    "relative h-7 min-w-0 flex-auto shrink rounded-sm px-2 text-xs font-medium text-muted-foreground",
    "hover:bg-background/50 hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
    "border border-transparent dark:data-[state=on]:border-input dark:data-[state=on]:bg-input/30",
    size === "sm" && "h-6 px-1.5",
  );

  return (
    <Field className={cn("@container/effort gap-2", className)}>
      <FieldTitle id={labelId} className={cn(size === "sm" && "text-xs")}>
        {t("label")}
      </FieldTitle>

      {stops.length > 0 && (
        <ToggleGroup
          type="single"
          spacing={0.5}
          aria-labelledby={labelId}
          value={inheriting ? DEFAULT : shown === "default" ? "" : shown}
          // An empty value is the selected segment clicked again: it keeps "Default", and pins the effort a
          // stored one the model does not offer resolves to.
          onValueChange={(next) => {
            const picked = next || (inheriting ? "" : shown);
            if (picked) onChange(picked === DEFAULT ? null : (picked as Stop));
          }}
          className="w-full rounded-md bg-muted p-0.5"
        >
          <ToggleGroupItem value={DEFAULT} aria-label={defaultLine} title={defaultLine} className={segment}>
            <span className="truncate">{label("default")}</span>
          </ToggleGroupItem>
          {stops.map((stop) => (
            <ToggleGroupItem
              key={stop}
              value={stop}
              aria-label={label(stop)}
              title={label(stop)}
              className={cn(
                segment,
                // Where "Default" lands, without looking selected.
                inheriting &&
                  stop === shown &&
                  "after:absolute after:top-1 after:right-1 after:size-1 after:rounded-full after:bg-muted-foreground/60",
              )}
            >
              {/* Short labels so every segment fits a narrow popover; full ones when there is room. */}
              <span className="truncate @xl/effort:hidden">{t(`short.${stop}`)}</span>
              <span className="hidden truncate @xl/effort:inline">{label(stop)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      <FieldDescription className={cn(textSize)}>
        <span className="font-medium text-foreground">{inheriting ? defaultLine : label(shown)}</span>
        {stops.length > 0 && (!inheriting || shown !== "default") && <> · {t(`options.${shown}.hint`)}</>}
      </FieldDescription>
      {support === null && note(t("unsupported", { model: modelName }))}
      {support && stops.length === 0 && note(t("alwaysOn", { model: modelName }))}
      {stops.length > 0 &&
        effort !== "default" &&
        !stops.some((stop) => stop === effort) &&
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

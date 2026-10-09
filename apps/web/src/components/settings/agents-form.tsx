"use client";

import { type AgentSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { Gauge, Network, ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { FieldError, FieldGroup, FieldSeparator } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SettingsAdvanced } from "./settings-advanced";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.agents;

/** Settings > Agents: what every agent is told, how much runs at once and the limits a new agent starts with. */
export function AgentsSettingsForm({ initial }: { initial: AgentSettings }) {
  const t = useTranslations("settings.agents");
  const tv = useTranslations("settings.validation.agents");
  const form = useSettingsForm("agents", initial);
  const { values, set, error } = form;
  const limits = values.defaultLimits;
  const instructionsError = error("instructions");
  // The schema checks the timeout in milliseconds; the field and its message are in minutes.
  const timeoutError = error("defaultLimits.timeoutMs") && tv("timeoutMinutes", L.timeoutMinutes);

  return (
    <>
      <FormSection
        id="agents-instructions"
        icon={ScrollText}
        title={t("instructionsTitle")}
        description={t("instructionsDescription")}
      >
        <div
          className={cn(
            "overflow-hidden rounded-xl border bg-card shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/20",
            instructionsError && "border-destructive",
          )}
        >
          <Textarea
            id="agent-instructions"
            aria-label={t("instructionsTitle")}
            aria-invalid={Boolean(instructionsError)}
            value={values.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            placeholder={t("instructionsPlaceholder")}
            maxLength={L.instructionsLength.max}
            className="max-h-[60vh] min-h-36 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{t("instructionsFooter")}</span>
            <span className="tabular shrink-0">
              {t("instructionsLength", { count: values.instructions.length, max: L.instructionsLength.max })}
            </span>
          </div>
        </div>
        {instructionsError && <FieldError>{instructionsError}</FieldError>}
      </FormSection>

      <FormSection
        id="agents-delegation"
        icon={Network}
        title={t("delegationTitle")}
        description={t("delegationDescription")}
      >
        <FieldGroup>
          <SettingsNumberField
            id="parallel-delegations"
            label={t("parallelDelegations")}
            hint={t("parallelDelegationsHint", L.parallelDelegations)}
            value={values.parallelDelegations}
            onChange={(parallelDelegations) => set({ parallelDelegations })}
            error={error("parallelDelegations")}
            min={L.parallelDelegations.min}
            max={L.parallelDelegations.max}
          />
        </FieldGroup>
      </FormSection>

      <FormSection id="agents-limits" icon={Gauge} title={t("limitsTitle")} description={t("limitsDescription")}>
        <FieldGroup>
          <SettingsNumberField
            id="limit-max-steps"
            label={t("maxSteps")}
            hint={t("maxStepsHint")}
            value={limits.maxSteps}
            onChange={(maxSteps) => set({ defaultLimits: { maxSteps } })}
            error={error("defaultLimits.maxSteps")}
            min={L.maxSteps.min}
            max={L.maxSteps.max}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="limit-timeout"
            label={t("timeout")}
            hint={t("timeoutHint")}
            value={limits.timeoutMs / 60_000}
            onChange={(minutes) => set({ defaultLimits: { timeoutMs: minutes * 60_000 } })}
            error={timeoutError || undefined}
            min={L.timeoutMinutes.min}
            max={L.timeoutMinutes.max}
            unit={t("minutesUnit")}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="limit-budget"
            nullable
            decimal
            label={t("budget")}
            hint={t("budgetHint")}
            value={limits.budgetUsd}
            onChange={(budgetUsd) => set({ defaultLimits: { budgetUsd } })}
            error={error("defaultLimits.budgetUsd")}
            placeholder={t("noLimit")}
            unit="USD"
          />
        </FieldGroup>
      </FormSection>

      <SettingsAdvanced
        id="agents-advanced"
        summary={t("advancedSummary", { redelegations: values.maxRedelegations, fixRounds: values.maxFixRounds })}
        invalid={Boolean(error("maxRedelegations") || error("maxFixRounds"))}
      >
        <SettingsNumberField
          id="max-redelegations"
          label={t("maxRedelegations")}
          hint={t("maxRedelegationsHint")}
          value={values.maxRedelegations}
          onChange={(maxRedelegations) => set({ maxRedelegations })}
          error={error("maxRedelegations")}
          min={L.maxRedelegations.min}
          max={L.maxRedelegations.max}
        />
        <FieldSeparator />
        <SettingsNumberField
          id="max-fix-rounds"
          label={t("maxFixRounds")}
          hint={t("maxFixRoundsHint")}
          value={values.maxFixRounds}
          onChange={(maxFixRounds) => set({ maxFixRounds })}
          error={error("maxFixRounds")}
          min={L.maxFixRounds.min}
          max={L.maxFixRounds.max}
        />
      </SettingsAdvanced>

      <SettingsSaveBar
        dirty={form.dirty}
        invalid={form.invalid}
        pending={form.pending}
        onSave={form.save}
        onReset={form.reset}
      />
    </>
  );
}

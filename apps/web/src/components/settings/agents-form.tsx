"use client";

import { type AgentSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { FormSection, FormSubsection } from "@/components/app/form-section";
import { FieldError, FieldGroup, FieldSeparator } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SettingsAdvanced } from "./settings-advanced";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.agents;

/** How many times work is sent back, fixed, continued or retried on its own, then the waits (in minutes) before someone is told. */
const ROUND_COUNTS = ["maxRedelegations", "maxFixRounds", "maxContinuations", "maxAutoRounds", "transientRetries"] as const;
const FOLLOW_UP_MINUTES = [
  "questionEscalationMinutes",
  "userEscalationMinutes",
  "staleTaskMinutes",
  "deadlineEscalationMinutes",
  "progressMinutes",
] as const;
/** The Advanced section opens by itself while one of these has a problem. */
const ADVANCED_FIELDS = [
  "defaultLimits.maxSteps",
  "defaultLimits.timeoutMs",
  "defaultLimits.budgetUsd",
  ...ROUND_COUNTS,
  ...FOLLOW_UP_MINUTES,
] as const;

/**
 * Settings > Agents: what every agent is told up front; under Advanced, the limits a new agent starts with
 * and how work keeps moving on its own. How many tasks run at once is in Settings > System.
 */
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

      <SettingsAdvanced
        id="agents-advanced"
        summary={t("advancedSummary", { steps: limits.maxSteps, minutes: limits.timeoutMs / 60_000 })}
        invalid={ADVANCED_FIELDS.some((field) => error(field))}
      >
        <FormSubsection title={t("limitsTitle")} description={t("limitsDescription")}>
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
        </FormSubsection>

        <FieldSeparator />
        <FormSubsection title={t("roundsTitle")} description={t("roundsDescription")}>
          <FieldGroup>
            {ROUND_COUNTS.map((field, i) => (
              <Fragment key={field}>
                {i > 0 && <FieldSeparator />}
                <SettingsNumberField
                  id={`agents-${field}`}
                  label={t(field)}
                  hint={t(`${field}Hint`, L[field])}
                  value={values[field]}
                  onChange={(value) => set({ [field]: value })}
                  error={error(field)}
                  min={L[field].min}
                  max={L[field].max}
                />
              </Fragment>
            ))}
          </FieldGroup>
        </FormSubsection>

        <FieldSeparator />
        <FormSubsection title={t("followUpsTitle")} description={t("followUpsDescription")}>
          <FieldGroup>
            {FOLLOW_UP_MINUTES.map((field, i) => (
              <Fragment key={field}>
                {i > 0 && <FieldSeparator />}
                <SettingsNumberField
                  id={`agents-${field}`}
                  label={t(field)}
                  hint={t(`${field}Hint`)}
                  value={values[field]}
                  onChange={(value) => set({ [field]: value })}
                  error={error(field)}
                  min={L[field].min}
                  max={L[field].max}
                  unit={t("minutesUnit")}
                />
              </Fragment>
            ))}
          </FieldGroup>
        </FormSubsection>
      </SettingsAdvanced>

      <SettingsSaveBar form={form} />
    </>
  );
}

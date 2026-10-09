"use client";

import { type AgentSettings, SETTINGS_LIMITS, type SystemSettings } from "@abotica/core/settings";
import { BellRing, Gauge } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

/**
 * Settings > System, version and updates: `overview` (the version card), the automatic checks, then
 * `children` (the newer release's notes and how to update).
 */
export function SystemUpdatesForm({
  initial,
  overview,
  children,
}: {
  initial: SystemSettings;
  overview: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useTranslations("settings.system");
  const tu = useTranslations("settings.updates");
  const form = useSettingsForm("system", initial);
  const { values, set } = form;

  return (
    <>
      {overview}

      <FormSection id="system-update-checks" icon={BellRing} title={tu("autoTitle")} description={tu("autoDescription")}>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="update-checks">{t("updateChecks")}</FieldLabel>
            <FieldDescription>{tu("autoNote")}</FieldDescription>
          </FieldContent>
          <Switch
            id="update-checks"
            checked={values.updateChecks}
            onCheckedChange={(updateChecks) => set({ updateChecks })}
          />
        </Field>
      </FormSection>

      {children}

      <SettingsSaveBar form={form} />
    </>
  );
}

/**
 * Settings > System, work at once: the runs the worker executes at the same time (system settings) and the
 * tasks one conversation delegates at the same time (agent settings), each domain saved with its own form.
 */
export function WorkAtOnceForm({ system, agents }: { system: SystemSettings; agents: AgentSettings }) {
  const t = useTranslations("settings.system");
  const runs = useSettingsForm("system", system);
  const delegation = useSettingsForm("agents", agents);

  return (
    <>
      <FormSection id="work-at-once" icon={Gauge} title={t("workTitle")} description={t("workDescription")}>
        <FieldGroup>
          <SettingsNumberField
            id="run-concurrency"
            label={t("runConcurrency")}
            hint={t("runConcurrencyHint")}
            value={runs.values.runConcurrency}
            onChange={(runConcurrency) => runs.set({ runConcurrency })}
            error={runs.error("runConcurrency")}
            min={SETTINGS_LIMITS.system.runConcurrency.min}
            max={SETTINGS_LIMITS.system.runConcurrency.max}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="parallel-delegations"
            label={t("parallelDelegations")}
            hint={t("parallelDelegationsHint", SETTINGS_LIMITS.agents.parallelDelegations)}
            value={delegation.values.parallelDelegations}
            onChange={(parallelDelegations) => delegation.set({ parallelDelegations })}
            error={delegation.error("parallelDelegations")}
            min={SETTINGS_LIMITS.agents.parallelDelegations.min}
            max={SETTINGS_LIMITS.agents.parallelDelegations.max}
          />
          <FieldSeparator />
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="urgent-overflow">{t("urgentOverflow")}</FieldLabel>
              <FieldDescription>{t("urgentOverflowHint")}</FieldDescription>
            </FieldContent>
            <Switch
              id="urgent-overflow"
              checked={delegation.values.urgentOverflow}
              onCheckedChange={(urgentOverflow) => delegation.set({ urgentOverflow })}
            />
          </Field>
        </FieldGroup>
      </FormSection>

      {[runs, delegation].map((form, i) => (
        <SettingsSaveBar key={i} form={form} />
      ))}
    </>
  );
}

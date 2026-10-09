"use client";

import { SETTINGS_LIMITS, type SystemSettings } from "@abotica/core/settings";
import { Activity, BellRing } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.system;

/**
 * Settings > System: how many runs the worker executes at once (applied without a restart) and the
 * automatic update checks. `overview` (the version card) sits between them, `children` (the newer
 * release's notes and how to update) after.
 */
export function SystemSettingsForm({
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
  const { values, set, error } = form;

  return (
    <>
      <FormSection id="system-runs" icon={Activity} title={t("runsTitle")} description={t("runsDescription")}>
        <SettingsNumberField
          id="run-concurrency"
          label={t("runConcurrency")}
          hint={t("runConcurrencyHint")}
          value={values.runConcurrency}
          onChange={(runConcurrency) => set({ runConcurrency })}
          error={error("runConcurrency")}
          min={L.runConcurrency.min}
          max={L.runConcurrency.max}
        />
      </FormSection>

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

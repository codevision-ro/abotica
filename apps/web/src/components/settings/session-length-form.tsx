"use client";

import { type AppSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { FieldGroup } from "@/components/ui/field";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.security;

/** Settings > Account: how long a sign-in stays valid without being used. */
export function SessionLengthForm({ initial }: { initial: AppSettings["security"] }) {
  const t = useTranslations("settings.security");
  const form = useSettingsForm("security", initial);
  const { values, set, error } = form;

  return (
    <div className="flex flex-col gap-6">
      <FormSection
        id="session-length"
        icon={TimerReset}
        title={t("sessionLengthTitle")}
        description={t("sessionLengthDescription")}
      >
        <FieldGroup>
          <SettingsNumberField
            id="session-days"
            label={t("sessionDays")}
            hint={t("sessionDaysHint", L.sessionDays)}
            unit={t("days")}
            value={values.sessionDays}
            onChange={(sessionDays) => set({ sessionDays })}
            error={error("sessionDays")}
            {...L.sessionDays}
          />
        </FieldGroup>
      </FormSection>

      <SettingsSaveBar
        dirty={form.dirty}
        invalid={form.invalid}
        pending={form.pending}
        onSave={form.save}
        onReset={form.reset}
      />
    </div>
  );
}

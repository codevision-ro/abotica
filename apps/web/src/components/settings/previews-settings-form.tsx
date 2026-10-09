"use client";

import { type AppSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { FieldGroup, FieldSeparator } from "@/components/ui/field";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.previews;

/** Part of Settings > System: how long the links of new previews stay open. */
export function PreviewsSettingsForm({ initial }: { initial: AppSettings["previews"] }) {
  const t = useTranslations("settings.previews");
  const form = useSettingsForm("previews", initial);
  const { values, set, error } = form;

  return (
    <>
      <FormSection id="previews" icon={Link2} title={t("links.title")} description={t("links.description")}>
        <FieldGroup>
          <SettingsNumberField
            id="previews-live-hours"
            label={t("links.liveHours")}
            hint={t("links.liveHoursHint", L.liveHours)}
            unit={t("units.hours")}
            value={values.liveHours}
            onChange={(liveHours) => set({ liveHours })}
            error={error("liveHours")}
            {...L.liveHours}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="previews-static-days"
            label={t("links.staticDays")}
            hint={t("links.staticDaysHint", L.staticDays)}
            unit={t("units.days")}
            value={values.staticDays}
            onChange={(staticDays) => set({ staticDays })}
            error={error("staticDays")}
            {...L.staticDays}
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
    </>
  );
}

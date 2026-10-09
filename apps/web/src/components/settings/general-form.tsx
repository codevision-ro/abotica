"use client";

import type { GeneralSettings } from "@abotica/core/settings";
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineSection } from "./inline-section";
import { SettingsSaveBar } from "./settings-save-bar";
import { TimeZoneSelect } from "./time-zone-select";
import { useSettingsForm } from "./use-settings-form";

/** The general settings page: the time zone. The language next to it saves on its own (LanguageSelect). */
export function GeneralSettingsForm({ initial }: { initial: GeneralSettings }) {
  const t = useTranslations("settings.general");
  const form = useSettingsForm("general", initial);
  const error = form.error("timezone");

  return (
    <>
      <InlineSection
        titleId="timezone-title"
        icon={Globe}
        title={t("timezoneTitle")}
        description={error ? <span className="text-destructive">{error}</span> : t("timezoneDescription")}
      >
        <TimeZoneSelect
          id="timezone"
          value={form.values.timezone}
          onChange={(timezone) => form.set({ timezone })}
          invalid={Boolean(error)}
          className="w-full sm:w-64"
        />
      </InlineSection>
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

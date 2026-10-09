"use client";

import { type AppSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { BellRing, CalendarDays, CalendarRange } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { FormSection } from "@/components/app/form-section";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

type Period = "daily" | "weekly";

/** Weekdays as stored (0 = Sunday), listed from Monday. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

/** Hour and weekday names in the interface language; 2023-01-01 was a Sunday. */
function useCalendarNames() {
  const locale = useLocale();
  return useMemo(() => {
    const hour = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
    return {
      hour: (h: number) => hour.format(Date.UTC(2023, 0, 1, h)),
      weekday: (d: number) => weekday.format(Date.UTC(2023, 0, 1 + d)),
    };
  }, [locale]);
}

/** The reports part of Settings > Telegram: the daily and the weekly summary, each on or off at a time of the configured time zone. */
export function ReportsSettingsForm({ initial }: { initial: AppSettings["reports"] }) {
  const t = useTranslations("settings.reports");
  const form = useSettingsForm("reports", initial);
  const { values, set, error } = form;
  const names = useCalendarNames();
  const hours = Array.from({ length: 24 }, (_, h) => h);

  const enabledField = (period: Period) => (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={`reports-${period}-enabled`}>{t(`${period}.enabled`)}</FieldLabel>
        <FieldDescription>{t(`${period}.enabledHint`)}</FieldDescription>
      </FieldContent>
      <Switch
        id={`reports-${period}-enabled`}
        checked={values[period].enabled}
        onCheckedChange={(enabled) => set({ [period]: { enabled } })}
      />
    </Field>
  );

  const hourField = (period: Period) => (
    <Field orientation="responsive" data-disabled={!values[period].enabled}>
      <FieldContent>
        <FieldLabel htmlFor={`reports-${period}-hour`}>{t("hour")}</FieldLabel>
      </FieldContent>
      <Select
        value={String(values[period].hour)}
        onValueChange={(v) => set({ [period]: { hour: Number(v) } })}
        disabled={!values[period].enabled}
      >
        <SelectTrigger id={`reports-${period}-hour`} className="sm:w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {hours.map((h) => (
            <SelectItem key={h} value={String(h)}>
              {names.hour(h)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );

  return (
    <div className="flex flex-col gap-6">
      <FormSection id="reports-daily" icon={CalendarDays} title={t("daily.title")} description={t("daily.description")}>
        <FieldGroup>
          {enabledField("daily")}
          <FieldSeparator />
          {hourField("daily")}
        </FieldGroup>
      </FormSection>

      <FormSection id="reports-weekly" icon={CalendarRange} title={t("weekly.title")} description={t("weekly.description")}>
        <FieldGroup>
          {enabledField("weekly")}
          <FieldSeparator />
          <Field orientation="responsive" data-disabled={!values.weekly.enabled}>
            <FieldContent>
              <FieldLabel htmlFor="reports-weekly-day">{t("weekday")}</FieldLabel>
            </FieldContent>
            <Select
              value={String(values.weekly.weekday)}
              onValueChange={(v) => set({ weekly: { weekday: Number(v) } })}
              disabled={!values.weekly.enabled}
            >
              <SelectTrigger id="reports-weekly-day" className="sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {names.weekday(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FieldSeparator />
          {hourField("weekly")}
        </FieldGroup>
      </FormSection>

      {/* What waits for the user (the inbox), sent again in one message once it has waited this long. */}
      <FormSection id="reports-reminders" icon={BellRing} title={t("reminderHours")} description={t("reminderHoursHint")}>
        <SettingsNumberField
          id="reports-reminder-hours"
          label={t("reminderAfter")}
          value={values.reminderHours}
          onChange={(reminderHours) => set({ reminderHours })}
          error={error("reminderHours")}
          min={SETTINGS_LIMITS.reports.reminderHours.min}
          max={SETTINGS_LIMITS.reports.reminderHours.max}
          unit={t("hoursUnit")}
        />
      </FormSection>

      <SettingsSaveBar form={form} />
    </div>
  );
}

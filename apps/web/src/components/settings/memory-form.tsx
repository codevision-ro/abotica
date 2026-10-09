"use client";

import { type MemorySettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { BookOpenText, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { SettingsAdvanced } from "./settings-advanced";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.memory;

/**
 * Settings > Memory: how much memory and journal goes into a run, whether agents' memories need approval
 * and when old ones expire. The embedding provider above it saves on its own (EmbeddingProviderCard).
 */
export function MemorySettingsForm({ initial }: { initial: MemorySettings }) {
  const t = useTranslations("settings.memory");
  const form = useSettingsForm("memory", initial);
  const { values, set, error } = form;

  return (
    <>
      <FormSection id="memory-context" icon={BookOpenText} title={t("contextTitle")} description={t("contextDescription")}>
        <FieldGroup>
          <SettingsNumberField
            id="memory-pinned-tokens"
            label={t("pinnedTokens")}
            hint={t("pinnedTokensHint")}
            value={values.pinnedTokens}
            onChange={(pinnedTokens) => set({ pinnedTokens })}
            error={error("pinnedTokens")}
            min={L.pinnedTokens.min}
            max={L.pinnedTokens.max}
            step={100}
            unit={t("tokensUnit")}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="memory-recall-tokens"
            label={t("recallTokens")}
            hint={t("recallTokensHint")}
            value={values.recallTokens}
            onChange={(recallTokens) => set({ recallTokens })}
            error={error("recallTokens")}
            min={L.recallTokens.min}
            max={L.recallTokens.max}
            step={100}
            unit={t("tokensUnit")}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="memory-journal-days"
            label={t("journalDays")}
            hint={t("journalDaysHint")}
            value={values.journalDays}
            onChange={(journalDays) => set({ journalDays })}
            error={error("journalDays")}
            min={L.journalDays.min}
            max={L.journalDays.max}
            unit={t("daysUnit")}
          />
        </FieldGroup>
      </FormSection>

      <FormSection
        id="memory-approval"
        icon={ShieldCheck}
        title={t("approvalTitle")}
        description={t("approvalDescription")}
      >
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="memory-requires-approval">{t("requiresApproval")}</FieldLabel>
            <FieldDescription>{t("requiresApprovalHint")}</FieldDescription>
          </FieldContent>
          <Switch
            id="memory-requires-approval"
            checked={values.requiresApproval}
            onCheckedChange={(requiresApproval) => set({ requiresApproval })}
          />
        </Field>
      </FormSection>

      <SettingsAdvanced
        id="memory-advanced"
        summary={t("advancedSummary", { ephemeral: values.ephemeralDays, unused: values.unusedDays })}
        invalid={Boolean(error("ephemeralDays") || error("unusedDays"))}
      >
        <SettingsNumberField
          id="memory-ephemeral-days"
          label={t("ephemeralDays")}
          hint={t("ephemeralDaysHint")}
          value={values.ephemeralDays}
          onChange={(ephemeralDays) => set({ ephemeralDays })}
          error={error("ephemeralDays")}
          min={L.ephemeralDays.min}
          max={L.ephemeralDays.max}
          unit={t("daysUnit")}
        />
        <FieldSeparator />
        <SettingsNumberField
          id="memory-unused-days"
          label={t("unusedDays")}
          hint={t("unusedDaysHint")}
          value={values.unusedDays}
          onChange={(unusedDays) => set({ unusedDays })}
          error={error("unusedDays")}
          min={L.unusedDays.min}
          max={L.unusedDays.max}
          unit={t("daysUnit")}
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

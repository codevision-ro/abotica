"use client";

import { type MemorySettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import { useTranslations } from "next-intl";
import { FieldSeparator } from "@/components/ui/field";
import { SettingsAdvanced } from "./settings-advanced";
import { SettingsNumberField } from "./settings-number-field";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

const L = SETTINGS_LIMITS.memory;

const FIELDS = ["pinnedTokens", "recallTokens", "journalDays", "ephemeralDays", "unusedDays"] as const;

/**
 * The memory part of Settings > Agents, under Advanced: how much memory and journal goes into a run and
 * when old memories expire. The embeddings card above it saves on its own (EmbeddingProviderCard).
 */
export function MemorySettingsForm({ initial }: { initial: MemorySettings }) {
  const t = useTranslations("settings.memory");
  const form = useSettingsForm("memory", initial);
  const { values, set, error } = form;
  const unit = (field: (typeof FIELDS)[number]) => (field.endsWith("Tokens") ? t("tokensUnit") : t("daysUnit"));

  return (
    <>
      <SettingsAdvanced
        id="memory-advanced"
        summary={t("advancedSummary", {
          pinned: values.pinnedTokens,
          recall: values.recallTokens,
          days: values.journalDays,
        })}
        invalid={FIELDS.some((field) => error(field))}
      >
        {FIELDS.map((field, i) => (
          <div key={field} className="contents">
            {i > 0 && <FieldSeparator />}
            <SettingsNumberField
              id={`memory-${field}`}
              label={t(field)}
              hint={t(`${field}Hint`)}
              value={values[field]}
              onChange={(value) => set({ [field]: value })}
              error={error(field)}
              min={L[field].min}
              max={L[field].max}
              step={field.endsWith("Tokens") ? 100 : undefined}
              unit={unit(field)}
            />
          </div>
        ))}
      </SettingsAdvanced>

      <SettingsSaveBar form={form} />
    </>
  );
}

"use client";

import { CLOUD_PROVIDER_IDS, DEFAULT_PROVIDER_BASE_URLS, PROVIDERS } from "@abotica/core/provider-info";
import { MODEL_ROLES, type ModelRole, type ModelSettings, type SettingsPatch } from "@abotica/core/settings";
import { useTranslations } from "next-intl";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { saveSettings } from "@/server/actions/app-settings";
import { updateDefaultModels } from "@/server/actions/settings";
import { type ChainOptions, DefaultModelsSection } from "./default-models-form";
import { SettingsAdvanced } from "./settings-advanced";
import { SettingsSaveBar } from "./settings-save-bar";
import { useSettingsForm } from "./use-settings-form";

/**
 * Settings > Models below the providers: the default models per role, then `children` (ratings, catalog),
 * then the API address per cloud provider, all saved by one bar. The defaults go through their own action,
 * which checks every model's provider is connected; the addresses through saveSettings.
 */
export function ModelsSettingsForm({
  initial,
  options,
  inheritingAgents,
  children,
}: {
  initial: ModelSettings;
  /** The connected providers and their models; null while none is connected, which hides the defaults. */
  options: ChainOptions | null;
  inheritingAgents: Record<ModelRole, number>;
  children?: React.ReactNode;
}) {
  const t = useTranslations("settings.models");
  const firstConfigured = options?.providers.find((p) => p.configured)?.id;
  // With no default yet, the specialists' chain starts with an empty row to pick the first model in.
  const seeded =
    options && firstConfigured && !initial.chains.agent.length
      ? { ...initial, chains: { ...initial.chains, agent: [{ provider: firstConfigured, model: "" }] } }
      : initial;
  const form = useSettingsForm("models", seeded, {
    submit: async (patch: SettingsPatch<ModelSettings>, values) => {
      let result: Awaited<ReturnType<typeof updateDefaultModels>> | null = null;
      if (patch.chains || patch.reasoningEffort) {
        result = await updateDefaultModels({ chains: values.chains, reasoningEffort: values.reasoningEffort });
        if (!result.ok) return result;
      }
      if (patch.baseUrls) {
        const saved = await saveSettings({ domain: "models", patch: { baseUrls: values.baseUrls } });
        return saved.ok ? { ok: true, data: saved.data as ModelSettings } : saved;
      }
      return result ?? { ok: true, data: values };
    },
  });
  const { values, set, error, errorUnder } = form;
  const custom = CLOUD_PROVIDER_IDS.filter((id) => values.baseUrls[id] !== null);

  return (
    <>
      {options && (
        <DefaultModelsSection
          value={values}
          onChange={(patch) => set(patch)}
          errors={Object.fromEntries(MODEL_ROLES.map((role) => [role, errorUnder(`chains.${role}`)]))}
          options={options}
          inheritingAgents={inheritingAgents}
        />
      )}
      {children}
      <SettingsAdvanced
        id="models-advanced"
        summary={
          custom.length
            ? t("baseUrlsCustom", { providers: custom.map((id) => PROVIDERS[id].label).join(", ") })
            : t("baseUrlsDefault")
        }
        invalid={Boolean(errorUnder("baseUrls"))}
      >
        <p className="text-sm text-pretty text-muted-foreground">{t("baseUrlsDescription")}</p>
        {CLOUD_PROVIDER_IDS.map((id, i) => {
          const problem = error(`baseUrls.${id}`);
          return (
            <div key={id} className="contents">
              {i > 0 && <FieldSeparator />}
              <Field orientation="responsive" data-invalid={Boolean(problem)}>
                <FieldContent>
                  <FieldLabel htmlFor={`base-url-${id}`}>{PROVIDERS[id].label}</FieldLabel>
                  {problem ? <FieldError>{problem}</FieldError> : <FieldDescription>{t("baseUrlHint")}</FieldDescription>}
                </FieldContent>
                <Input
                  id={`base-url-${id}`}
                  inputMode="url"
                  spellCheck={false}
                  autoComplete="off"
                  value={values.baseUrls[id] ?? ""}
                  onChange={(e) => set({ baseUrls: { [id]: e.target.value.trim() === "" ? null : e.target.value } })}
                  placeholder={DEFAULT_PROVIDER_BASE_URLS[id]}
                  aria-invalid={Boolean(problem)}
                  className="font-mono text-xs sm:w-72"
                />
              </Field>
            </div>
          );
        })}
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

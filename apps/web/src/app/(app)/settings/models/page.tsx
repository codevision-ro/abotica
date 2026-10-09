import { PROVIDERS } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CatalogRefresh } from "@/components/settings/catalog-refresh";
import { ModelRatings } from "@/components/settings/model-ratings";
import { ModelsSettingsForm } from "@/components/settings/models-form";
import { ProviderList } from "@/components/settings/provider-list";
import { getAgentFormOptions } from "@/server/queries/agents";
import { listModelRatings } from "@/server/queries/models";
import { getAppSettings, getInheritingAgentCount, listProviderStatuses } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("models") };
}

export default async function ModelsSettingsPage() {
  const [providers, options, inheriting, ratings, settings] = await Promise.all([
    listProviderStatuses(),
    getAgentFormOptions(),
    getInheritingAgentCount(),
    listModelRatings(),
    getAppSettings(),
  ]);
  const active = providers.filter((p) => p.connection !== null);
  const labels = Object.fromEntries(active.map((p) => [p.id, PROVIDERS[p.id].label]));
  const counts = Object.fromEntries(active.map((p) => [p.id, p.modelCount]));

  return (
    <>
      <ProviderList providers={providers} ollamaBaseUrl={settings.models.ollama.baseUrl} />
      <ModelsSettingsForm
        initial={settings.models}
        options={active.length ? { providers: options.providers, models: options.models } : null}
        inheritingAgents={inheriting}
      >
        {active.length > 0 && (
          <>
            <ModelRatings {...ratings} />
            <CatalogRefresh labels={labels} initialCounts={counts} />
          </>
        )}
      </ModelsSettingsForm>
    </>
  );
}

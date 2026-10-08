import { PROVIDERS } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CatalogRefresh } from "@/components/settings/catalog-refresh";
import { DefaultModelsForm } from "@/components/settings/default-models-form";
import { EmbeddingProviderCard } from "@/components/settings/embedding-provider-card";
import { ModelRatings } from "@/components/settings/model-ratings";
import { ProviderList } from "@/components/settings/provider-list";
import { getAgentFormOptions } from "@/server/queries/agents";
import { getEmbeddingStatus } from "@/server/queries/embeddings";
import { listModelRatings } from "@/server/queries/models";
import { getAppSettings, getInheritingAgentCount, listProviderStatuses } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("providers") };
}

export default async function ProvidersPage() {
  const [providers, options, inheriting, ratings, settings, embeddings] = await Promise.all([
    listProviderStatuses(),
    getAgentFormOptions(),
    getInheritingAgentCount(),
    listModelRatings(),
    getAppSettings(),
    getEmbeddingStatus(),
  ]);
  const active = providers.filter((p) => p.connection !== null);
  const labels = Object.fromEntries(active.map((p) => [p.id, PROVIDERS[p.id].label]));
  const counts = Object.fromEntries(active.map((p) => [p.id, p.modelCount]));

  return (
    <>
      <ProviderList providers={providers} ollamaBaseUrl={settings.ollamaBaseUrl} />
      {active.length > 0 && (
        <>
          <DefaultModelsForm
            initial={options}
            options={{ providers: options.providers, models: options.models }}
            inheritingAgents={inheriting}
          />
          <ModelRatings {...ratings} />
          <CatalogRefresh labels={labels} initialCounts={counts} />
        </>
      )}
      <EmbeddingProviderCard status={embeddings} ollamaBaseUrl={settings.ollamaBaseUrl} />
    </>
  );
}

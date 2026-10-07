import { env, PROVIDERS } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CatalogRefresh } from "@/components/settings/catalog-refresh";
import { DefaultModelsForm } from "@/components/settings/default-models-form";
import { ProviderList } from "@/components/settings/provider-list";
import { SettingsNote } from "@/components/settings/settings-note";
import { getAgentFormOptions } from "@/server/queries/agents";
import { getInheritingAgentCount, listProviderStatuses } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("providers") };
}

export default async function ProvidersPage() {
  const [providers, options, inheriting, t] = await Promise.all([
    listProviderStatuses(),
    getAgentFormOptions(),
    getInheritingAgentCount(),
    getTranslations("settings.providers"),
  ]);
  const active = providers.filter((p) => p.connection !== null);
  const labels = Object.fromEntries(active.map((p) => [p.id, PROVIDERS[p.id].label]));
  const counts = Object.fromEntries(active.map((p) => [p.id, p.modelCount]));
  const embeddingProvider = env().EMBEDDING_PROVIDER;

  return (
    <>
      <ProviderList providers={providers} ollamaBaseUrl={env().OLLAMA_BASE_URL} />
      {active.length > 0 && (
        <>
          <DefaultModelsForm
            initial={options.defaultModels}
            initialEffort={options.defaultReasoningEffort}
            options={{ providers: options.providers, models: options.models }}
            inheritingAgents={inheriting}
          />
          <CatalogRefresh labels={labels} initialCounts={counts} />
        </>
      )}
      <SettingsNote title={t("embeddingsTitle")}>
        {t.rich(embeddingProvider === "openai" ? "embeddingsBodyOpenai" : "embeddingsBody", {
          provider: embeddingProvider,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </SettingsNote>
    </>
  );
}

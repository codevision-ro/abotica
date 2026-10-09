import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AgentsSettingsForm } from "@/components/settings/agents-form";
import { EmbeddingProviderCard } from "@/components/settings/embedding-provider-card";
import { MemorySettingsForm } from "@/components/settings/memory-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getEmbeddingStatus } from "@/server/queries/embeddings";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("agents") };
}

/** What every agent is told and how work moves on its own, then how agents remember. */
export default async function AgentsSettingsPage() {
  const [settings, embeddings, t, tm] = await Promise.all([
    getAppSettings(),
    getEmbeddingStatus(),
    getTranslations("settings.agents"),
    getTranslations("settings.memory"),
  ]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <AgentsSettingsForm initial={settings.agents} />
      <SectionHeader id="memory" title={tm("title")} description={tm("description")} />
      <EmbeddingProviderCard status={embeddings} ollama={settings.models.ollama} />
      <MemorySettingsForm initial={settings.memory} />
    </>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EmbeddingProviderCard } from "@/components/settings/embedding-provider-card";
import { MemorySettingsForm } from "@/components/settings/memory-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getEmbeddingStatus } from "@/server/queries/embeddings";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("memory") };
}

export default async function MemorySettingsPage() {
  const [settings, embeddings, t] = await Promise.all([
    getAppSettings(),
    getEmbeddingStatus(),
    getTranslations("settings.memory"),
  ]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <EmbeddingProviderCard status={embeddings} ollama={settings.models.ollama} />
      <MemorySettingsForm initial={settings.memory} />
    </>
  );
}

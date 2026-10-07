import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { VaultManager } from "@/components/settings/vault-manager";
import { listProjectOptions, listVaultSecrets } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("vault") };
}

export default async function VaultPage() {
  const [secrets, projects, t] = await Promise.all([
    listVaultSecrets(),
    listProjectOptions(),
    getTranslations("settings.vault"),
  ]);
  return <VaultManager title={t("title")} description={t("description")} secrets={secrets} projects={projects} />;
}

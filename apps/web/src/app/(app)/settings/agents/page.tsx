import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AgentsSettingsForm } from "@/components/settings/agents-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("agents") };
}

export default async function AgentsSettingsPage() {
  const [settings, t] = await Promise.all([getAppSettings(), getTranslations("settings.agents")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <AgentsSettingsForm initial={settings.agents} />
    </>
  );
}

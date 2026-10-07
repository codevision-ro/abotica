import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GeneralSettingsForm } from "@/components/settings/general-form";
import { LanguageSelect } from "@/components/settings/language-select";
import { SectionHeader } from "@/components/settings/section-header";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("general") };
}

export default async function GeneralSettingsPage() {
  const t = await getTranslations("settings.general");
  const settings = await getAppSettings();
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <LanguageSelect initial={settings.locale} />
      <GeneralSettingsForm initial={settings} />
    </>
  );
}

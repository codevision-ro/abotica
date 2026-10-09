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
  const [settings, t] = await Promise.all([getAppSettings(), getTranslations("settings.general")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <LanguageSelect initial={settings.general.locale} />
      <GeneralSettingsForm initial={settings.general} />
    </>
  );
}

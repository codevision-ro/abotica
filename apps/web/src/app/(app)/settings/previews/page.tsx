import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PreviewsSettingsForm } from "@/components/settings/previews-settings-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.previews");
  return { title: t("title") };
}

export default async function PreviewsSettingsPage() {
  const [settings, t] = await Promise.all([getAppSettings(), getTranslations("settings.previews")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <PreviewsSettingsForm initial={settings.previews} />
    </>
  );
}

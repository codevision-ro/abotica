import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BudgetSettingsForm } from "@/components/settings/budget-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("budget") };
}

export default async function BudgetSettingsPage() {
  const [settings, t] = await Promise.all([getAppSettings(), getTranslations("settings.budget")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <BudgetSettingsForm initial={settings.budget} />
    </>
  );
}

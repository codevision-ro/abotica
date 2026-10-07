import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SandboxSettingsForm } from "@/components/sandbox/sandbox-settings-form";
import { SandboxStatusCard } from "@/components/sandbox/sandbox-status-card";
import { SectionHeader } from "@/components/settings/section-header";
import { getSandboxPage } from "@/server/queries/sandbox";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("sandbox") };
}

export default async function SandboxSettingsPage() {
  const [{ settings, status }, t] = await Promise.all([getSandboxPage(), getTranslations("sandbox.settings")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <SandboxStatusCard status={status} />
      <SandboxSettingsForm initial={settings} status={status} />
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ReportsSettingsForm } from "@/components/settings/reports-settings-form";
import { SectionHeader } from "@/components/settings/section-header";
import { getAppSettings } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.reports");
  return { title: t("title") };
}

export default async function ReportsSettingsPage() {
  const [settings, t] = await Promise.all([getAppSettings(), getTranslations("settings.reports")]);
  return (
    <>
      <SectionHeader
        title={t("title")}
        description={t.rich("description", {
          timezone: settings.general.timezone,
          zone: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          link: (chunks) => (
            <Link href="/settings" className="underline underline-offset-4 hover:text-foreground">
              {chunks}
            </Link>
          ),
        })}
      />
      <ReportsSettingsForm initial={settings.reports} />
    </>
  );
}

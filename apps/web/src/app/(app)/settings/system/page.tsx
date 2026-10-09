import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/settings/section-header";
import { SystemSettingsForm } from "@/components/settings/system-form";
import { UpdateCheckButton } from "@/components/updates/update-check-button";
import { UpdateCommand } from "@/components/updates/update-command";
import { UpdateNotes } from "@/components/updates/update-notes";
import { UpdateOverview } from "@/components/updates/update-overview";
import { getAppSettings } from "@/server/queries/settings";
import { getUpdatesPage } from "@/server/queries/updates";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("system") };
}

export default async function SystemSettingsPage() {
  const [settings, { status, repo, runningRuns }, t] = await Promise.all([
    getAppSettings(),
    getUpdatesPage(),
    getTranslations("settings.system"),
  ]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <SystemSettingsForm
        initial={settings.system}
        overview={<UpdateOverview status={status} action={<UpdateCheckButton />} />}
      >
        {status.available && status.latest && (
          <>
            <UpdateNotes release={status.latest} />
            <UpdateCommand repo={repo} runningRuns={runningRuns} />
          </>
        )}
      </SystemSettingsForm>
    </>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionHeader } from "@/components/settings/section-header";
import { UpdateCheckButton } from "@/components/updates/update-check-button";
import { UpdateChecksToggle } from "@/components/updates/update-checks-toggle";
import { UpdateCommand } from "@/components/updates/update-command";
import { UpdateNotes } from "@/components/updates/update-notes";
import { UpdateOverview } from "@/components/updates/update-overview";
import { getUpdatesPage } from "@/server/queries/updates";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("updates") };
}

export default async function UpdatesSettingsPage() {
  const [{ status, repo, runningRuns }, t] = await Promise.all([getUpdatesPage(), getTranslations("settings.updates")]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} actions={<UpdateCheckButton />} />
      <UpdateOverview status={status} />
      {status.available && status.latest && (
        <>
          <UpdateNotes release={status.latest} />
          <UpdateCommand repo={repo} runningRuns={runningRuns} />
        </>
      )}
      <UpdateChecksToggle initial={status.enabled} />
    </>
  );
}

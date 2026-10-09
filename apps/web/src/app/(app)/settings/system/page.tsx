import { ArrowRight, ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SandboxSettingsForm } from "@/components/sandbox/sandbox-settings-form";
import { InlineSection } from "@/components/settings/inline-section";
import { PreviewsSettingsForm } from "@/components/settings/previews-settings-form";
import { SectionHeader } from "@/components/settings/section-header";
import { SystemUpdatesForm, WorkAtOnceForm } from "@/components/settings/system-form";
import { Button } from "@/components/ui/button";
import { UpdateCheckButton } from "@/components/updates/update-check-button";
import { UpdateCommand } from "@/components/updates/update-command";
import { UpdateNotes } from "@/components/updates/update-notes";
import { UpdateOverview } from "@/components/updates/update-overview";
import { getSandboxStatusView } from "@/server/queries/sandbox";
import { getAppSettings } from "@/server/queries/settings";
import { getUpdatesPage } from "@/server/queries/updates";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("system") };
}

/** The version and its updates, the sandbox, preview links, how much works at once, and the audit log. */
export default async function SystemSettingsPage() {
  const [settings, sandboxStatus, { status, repo, runningRuns }, t] = await Promise.all([
    getAppSettings(),
    getSandboxStatusView(),
    getUpdatesPage(),
    getTranslations("settings.system"),
  ]);
  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <SystemUpdatesForm
        initial={settings.system}
        overview={<UpdateOverview status={status} action={<UpdateCheckButton />} />}
      >
        {status.available && status.latest && (
          <>
            <UpdateNotes release={status.latest} />
            <UpdateCommand repo={repo} runningRuns={runningRuns} />
          </>
        )}
      </SystemUpdatesForm>
      <SandboxSettingsForm initial={settings.sandbox} status={sandboxStatus} />
      <PreviewsSettingsForm initial={settings.previews} />
      <WorkAtOnceForm system={settings.system} agents={settings.agents} />
      <InlineSection icon={ScrollText} title={t("auditTitle")} description={t("auditDescription")}>
        <Button asChild variant="outline" size="sm" className="max-sm:w-full">
          <Link href="/settings/audit">
            {t("auditOpen")} <ArrowRight />
          </Link>
        </Button>
      </InlineSection>
    </>
  );
}

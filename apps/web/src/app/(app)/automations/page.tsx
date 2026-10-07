import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SchedulesSection } from "@/components/automations/schedules-section";
import { TriggersSection } from "@/components/automations/triggers-section";
import { UrlTabs } from "@/components/memory/url-tabs";
import { getAutomationOptions, listSchedules, listTriggers } from "@/server/queries/automations";
import { appUrl } from "@/server/request-origin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("automations");
  return { title: t("meta.title") };
}

export default async function AutomationsPage(props: PageProps<"/automations">) {
  const sp = await props.searchParams;
  const t = await getTranslations("automations.page");
  const tab = sp.tab === "triggers" ? "triggers" : "schedules";
  const [options, schedules, triggers] = await Promise.all([getAutomationOptions(), listSchedules(), listTriggers()]);
  const tabs = (
    <UrlTabs
      value={tab}
      params={{ tab: tab === "triggers" ? "triggers" : undefined }}
      tabs={[
        { value: "schedules", label: t("tabs.schedules"), count: schedules.length },
        { value: "triggers", label: t("tabs.triggers"), count: triggers.length },
      ]}
    />
  );

  return (
    <PageBody>
      <PageHeader title={t("title")} description={t("description")} />
      {tab === "schedules" ? (
        <SchedulesSection
          schedules={schedules}
          agents={options.agents}
          projects={options.projects}
          timezone={options.timezone}
          toolbar={tabs}
        />
      ) : (
        <TriggersSection
          triggers={triggers}
          agents={options.agents}
          projects={options.projects}
          appUrl={appUrl()}
          toolbar={tabs}
        />
      )}
    </PageBody>
  );
}

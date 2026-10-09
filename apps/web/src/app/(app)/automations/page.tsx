import { XIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SchedulesSection } from "@/components/automations/schedules-section";
import { TriggersSection } from "@/components/automations/triggers-section";
import { UrlTabs } from "@/components/memory/url-tabs";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import { getAutomationOptions, listSchedules, listTriggers } from "@/server/queries/automations";
import { appUrl } from "@/server/request-origin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("automations");
  return { title: t("meta.title") };
}

export default async function AutomationsPage(props: PageProps<"/automations">) {
  const sp = await props.searchParams;
  const t = await getTranslations("automations.page");
  const ta = await getTranslations("agents.activity");
  const tab = sp.tab === "triggers" ? "triggers" : "schedules";
  // `?agent=` on the schedules tab: only that agent's schedules (linked from the agent's Activity tab).
  const agentId = tab === "schedules" && typeof sp.agent === "string" && isUuid(sp.agent) ? sp.agent : null;
  const [options, allSchedules, triggers] = await Promise.all([getAutomationOptions(), listSchedules(), listTriggers()]);
  const agentName = agentId
    ? (options.agents.find((a) => a.id === agentId)?.name ?? allSchedules.find((s) => s.agentId === agentId)?.agentName)
    : undefined;
  const schedules = agentName ? allSchedules.filter((s) => s.agentId === agentId) : allSchedules;
  const filter = agentName && (
    <Button variant="outline" size="sm" asChild>
      <Link href="/automations" title={ta("showAll")}>
        <span className="max-w-40 truncate">{ta("onlyAgent", { name: agentName })}</span>
        <XIcon aria-hidden />
        <span className="sr-only">{ta("showAll")}</span>
      </Link>
    </Button>
  );
  const tabs = (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <UrlTabs
        value={tab}
        params={{ tab: tab === "triggers" ? "triggers" : undefined }}
        tabs={[
          { value: "schedules", label: t("tabs.schedules"), count: schedules.length },
          { value: "triggers", label: t("tabs.triggers"), count: triggers.length },
        ]}
      />
      {filter}
    </div>
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

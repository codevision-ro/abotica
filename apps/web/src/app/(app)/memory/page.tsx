import { Bot, FolderKanban, Globe, MessagesSquare, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { ConversationTable } from "@/components/memory/conversation-table";
import { CreateMemoryDialog } from "@/components/memory/memory-dialogs";
import { ParamSelect } from "@/components/memory/memory-filter";
import { MemoryList } from "@/components/memory/memory-list";
import { MemoryPanel, PanelEmpty } from "@/components/memory/memory-panel";
import { QuerySearch } from "@/components/memory/memory-search";
import { PageLinks } from "@/components/memory/page-links";
import { PendingList } from "@/components/memory/pending-list";
import { PriorityCard } from "@/components/memory/priority-card";
import { UrlTabs } from "@/components/memory/url-tabs";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import {
  getConversationPage,
  getMemoryCounts,
  getMemoryOptions,
  getMemorySearchResults,
  listMemories,
  listPendingMemories,
} from "@/server/queries/memory";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("memory");
  return { title: t("meta.title") };
}

const TABS = ["global", "project", "agent", "pending", "conversations"] as const;
type Tab = (typeof TABS)[number];

const SCOPE_ICON = { global: Globe, project: FolderKanban, agent: Bot } as const;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const inlineLink = "font-medium text-foreground underline underline-offset-2 hover:text-primary";

export default async function MemoryPage(props: PageProps<"/memory">) {
  const sp = await props.searchParams;
  const t = await getTranslations("memory");
  const rawTab = one(sp.tab);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "global";
  const q = one(sp.q)?.trim() || undefined;
  const project = isUuid(one(sp.project)) ? one(sp.project) : undefined;
  const agent = isUuid(one(sp.agent)) ? one(sp.agent) : undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const params = { tab: tab === "global" ? undefined : tab, q, project, agent };

  const [options, counts, search] = await Promise.all([
    getMemoryOptions(),
    getMemoryCounts(),
    q ? getMemorySearchResults(q) : Promise.resolve(null),
  ]);

  const tabs = [
    { value: "global", label: t("scopes.global"), count: counts.global },
    { value: "project", label: t("scopes.project"), count: counts.project },
    { value: "agent", label: t("scopes.agent"), count: counts.agent },
    { value: "pending", label: t("page.tabs.pending"), count: counts.pending, tone: "warning" as const },
    { value: "conversations", label: t("page.tabs.conversations") },
  ];

  const defaultScope = tab === "project" || tab === "agent" ? tab : "global";
  // The approval queue brings its own primary button, so the header one steps back there.
  const reviewing = tab === "pending" && counts.pending > 0;

  return (
    <PageBody>
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <CreateMemoryDialog
            agents={options.agents}
            projects={options.projects}
            defaultScope={defaultScope}
            defaultProjectId={project}
            defaultAgentId={agent}
            trigger={
              reviewing ? (
                <Button variant="outline">
                  <Plus /> {t("dialog.add")}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center">
            <UrlTabs value={tab} tabs={tabs} params={params} />
            <QuerySearch
              key={q ?? ""}
              params={params}
              label={t("search.label")}
              placeholder={t("search.placeholder")}
              className="min-w-0 md:flex-1"
            />
          </div>

          {search && (
            <MemoryPanel
              icon={Search}
              title={t("search.resultsFor", { query: q ?? "" })}
              description={search.semantic ? t("search.semantic") : t("search.text")}
            >
              {search.rows.length ? (
                <MemoryList items={search.rows} showScope flush />
              ) : (
                <PanelEmpty>{t("search.empty")}</PanelEmpty>
              )}
            </MemoryPanel>
          )}

          {(tab === "global" || tab === "project" || tab === "agent") && (
            <ScopeTab scope={tab} project={project} agent={agent} params={params} options={options} />
          )}
          {tab === "pending" && <PendingTab />}
          {tab === "conversations" && <ConversationsTab page={page} params={params} />}
        </div>

        <aside className="lg:sticky lg:top-6">
          <PriorityCard />
        </aside>
      </div>
    </PageBody>
  );
}

async function ScopeTab({
  scope,
  project,
  agent,
  params,
  options,
}: {
  scope: "global" | "project" | "agent";
  project?: string;
  agent?: string;
  params: Record<string, string | undefined>;
  options: Awaited<ReturnType<typeof getMemoryOptions>>;
}) {
  const rows = await listMemories({ scope, projectId: project, agentId: agent });
  const t = await getTranslations("memory");
  return (
    <MemoryPanel
      icon={SCOPE_ICON[scope]}
      description={t(`dialog.scopeHelp.${scope}`)}
      action={
        scope === "project" ? (
          <ParamSelect
            param="project"
            params={params}
            label={t("filters.byProject")}
            allLabel={t("filters.allProjects")}
            options={options.projects}
            icon="project"
          />
        ) : scope === "agent" ? (
          <ParamSelect
            param="agent"
            params={params}
            label={t("filters.byAgent")}
            allLabel={t("filters.allAgents")}
            options={options.agents}
            icon="agent"
          />
        ) : undefined
      }
    >
      {rows.length ? (
        <MemoryList items={rows} flush />
      ) : (
        <PanelEmpty>
          {t.rich("empty", {
            add: (chunks) => (
              <CreateMemoryDialog
                agents={options.agents}
                projects={options.projects}
                defaultScope={scope}
                defaultProjectId={project}
                defaultAgentId={agent}
                trigger={
                  <button type="button" className={inlineLink}>
                    {chunks}
                  </button>
                }
              />
            ),
          })}
        </PanelEmpty>
      )}
    </MemoryPanel>
  );
}

async function PendingTab() {
  const rows = await listPendingMemories();
  const t = await getTranslations("memory.pending");
  if (!rows.length) {
    return (
      <div className={sectionCardClass}>
        <PanelEmpty>
          {t.rich("empty", {
            settings: (chunks) => (
              <Link href="/settings/general" className={inlineLink}>
                {chunks}
              </Link>
            ),
          })}
        </PanelEmpty>
      </div>
    );
  }
  return <PendingList items={rows} />;
}

async function ConversationsTab({ page, params }: { page: number; params: Record<string, string | undefined> }) {
  const data = await getConversationPage(page);
  const t = await getTranslations("memory.conversations");
  return (
    <MemoryPanel
      icon={MessagesSquare}
      title={t("alertTitle")}
      description={t("alertDescription")}
      footer={
        data.page > 1 || data.page < data.pageCount ? (
          <PageLinks
            basePath="/memory"
            params={params}
            page={data.page}
            hasNext={data.page < data.pageCount}
            label={t("pageLabel", { total: data.total, page: data.page, pageCount: data.pageCount })}
          />
        ) : undefined
      }
    >
      {data.rows.length ? <ConversationTable rows={data.rows} page={data.page} /> : <PanelEmpty>{t("empty")}</PanelEmpty>}
    </MemoryPanel>
  );
}

import { parseISO } from "date-fns";
import { Bot, FolderKanban, Globe, Pin, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { ListPager, pageHref } from "@/components/app/list-pager";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass, SectionEmpty } from "@/components/app/section-card";
import { JournalDateRange } from "@/components/journals/journal-date-range";
import { JournalEntryCard } from "@/components/journals/journal-entry";
import { ORIGINS } from "@/components/memory/memory-badges";
import { CreateMemoryDialog } from "@/components/memory/memory-dialogs";
import { FiltersMenu, ParamSelect, ParamToggle } from "@/components/memory/memory-filter";
import { MemoryHelp } from "@/components/memory/memory-help";
import { MemoryList } from "@/components/memory/memory-list";
import { MemoryPanel } from "@/components/memory/memory-panel";
import { QuerySearch } from "@/components/memory/memory-search";
import { PendingList } from "@/components/memory/pending-list";
import { UrlTabs } from "@/components/memory/url-tabs";
import { Button } from "@/components/ui/button";
import { isDay } from "@/lib/day";
import { isUuid } from "@/lib/uuid";
import { getFormat } from "@/server/format";
import {
  AGENT_GLOBAL_ONLY,
  getJournalDays,
  getMemoryCounts,
  getMemoryOptions,
  getMemoryPage,
  getMemorySearchResults,
  listJournalSearchResults,
  listPendingMemories,
  MEMORY_PAGE_SIZE,
} from "@/server/queries/memory";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("memory");
  return { title: t("meta.title") };
}

const TABS = ["global", "project", "agent", "journal", "pending"] as const;
type Tab = (typeof TABS)[number];
type Scope = "global" | "project" | "agent";
type Options = Awaited<ReturnType<typeof getMemoryOptions>>;

const SCOPE_ICON = { global: Globe, project: FolderKanban, agent: Bot } as const;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const inlineLink = "font-medium text-foreground underline underline-offset-2 hover:text-primary";

export default async function MemoryPage(props: PageProps<"/memory">) {
  const sp = await props.searchParams;
  const [t, tj, options, counts] = await Promise.all([
    getTranslations("memory"),
    getTranslations("journals"),
    getMemoryOptions(),
    getMemoryCounts(),
  ]);
  const rawTab = one(sp.tab);
  // Pending is a tab only while something waits there.
  const requested = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "global";
  const tab: Tab = requested === "pending" && counts.pending === 0 ? "global" : requested;
  const q = one(sp.q)?.trim() || undefined;
  const agent = isUuid(one(sp.agent)) ? one(sp.agent) : undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);

  const tabs = [
    { value: "global", label: t("scopes.global"), count: counts.global },
    { value: "project", label: t("page.tabs.project"), count: counts.project },
    { value: "agent", label: t("page.tabs.agent"), count: counts.agent },
    { value: "journal", label: t("page.tabs.journal") },
    ...(counts.pending > 0
      ? [{ value: "pending", label: t("page.tabs.pending"), count: counts.pending, tone: "warning" as const }]
      : []),
  ];

  let body: React.ReactNode;
  let params: Record<string, string | undefined>;
  if (tab === "journal") {
    const from = isDay(one(sp.from)) ? one(sp.from) : undefined;
    const to = isDay(one(sp.to)) ? one(sp.to) : undefined;
    params = { tab, q, agent, from, to };
    body = <JournalTab q={q} agent={agent} from={from} to={to} page={page} params={params} options={options} />;
  } else {
    const rawProject = one(sp.project);
    // On the agent level the project filter can also keep only the agents' global memory.
    const project = isUuid(rawProject) || (tab === "agent" && rawProject === AGENT_GLOBAL_ONLY) ? rawProject : undefined;
    const origin = ORIGINS.find((o) => o === one(sp.origin));
    const flag = (key: string) => (one(sp[key]) === "1" ? "1" : undefined);
    params = {
      tab: tab === "global" ? undefined : tab,
      q,
      project,
      agent,
      origin,
      pinned: flag("pinned"),
      history: flag("history"),
      neverUsed: flag("neverUsed"),
    };
    body = (
      <>
        {q && <MemorySearchResults q={q} />}
        {tab === "pending" ? (
          <PendingList items={await listPendingMemories()} />
        ) : (
          <ScopeTab scope={tab} page={page} params={params} options={options} />
        )}
      </>
    );
  }

  const defaultScope: Scope = tab === "project" || tab === "agent" ? tab : "global";
  const dialogProject = isUuid(params.project) ? params.project : undefined;
  // The approval queue brings its own primary button, so the header one steps back there.
  const reviewing = tab === "pending";

  return (
    <PageBody>
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <>
            <MemoryHelp />
            <CreateMemoryDialog
              agents={options.agents}
              projects={options.projects}
              defaultScope={defaultScope}
              defaultProjectId={dialogProject}
              defaultAgentId={tab === "journal" ? undefined : agent}
              trigger={
                reviewing ? (
                  <Button variant="outline">
                    <Plus /> {t("dialog.add")}
                  </Button>
                ) : undefined
              }
            />
          </>
        }
      />

      <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center">
        <UrlTabs value={tab} tabs={tabs} params={params} />
        <QuerySearch
          key={`${tab === "journal"}${q ?? ""}`}
          params={params}
          label={tab === "journal" ? tj("search.label") : t("search.label")}
          placeholder={tab === "journal" ? tj("search.placeholder") : t("search.placeholder")}
          className="min-w-0 md:flex-1"
        />
      </div>

      {body}
    </PageBody>
  );
}

async function MemorySearchResults({ q }: { q: string }) {
  const [t, search] = await Promise.all([getTranslations("memory.search"), getMemorySearchResults(q)]);
  return (
    <MemoryPanel icon={Search} title={t("resultsFor", { query: q })}>
      {search.rows.length ? (
        <MemoryList items={search.rows} showScope flush />
      ) : (
        <SectionEmpty className="py-5">{t("empty")}</SectionEmpty>
      )}
    </MemoryPanel>
  );
}

async function ScopeTab({
  scope,
  page,
  params,
  options,
}: {
  scope: Scope;
  page: number;
  params: Record<string, string | undefined>;
  options: Options;
}) {
  const [t, data] = await Promise.all([
    getTranslations("memory"),
    getMemoryPage({
      scope,
      projectId: params.project,
      agentId: params.agent,
      origin: params.origin,
      pinned: params.pinned === "1",
      history: params.history === "1",
      neverUsed: params.neverUsed === "1",
      page,
    }),
  ]);
  return (
    <MemoryPanel
      icon={SCOPE_ICON[scope]}
      footer={
        data.pageCount > 1 && (
          <ListPager
            page={data.page}
            pageSize={MEMORY_PAGE_SIZE}
            rowCount={data.rows.length}
            total={data.total}
            href={(p) => pageHref("/memory", params, p)}
          />
        )
      }
      description={t(`dialog.scopeHelp.${scope}`)}
      action={
        <>
          {scope === "project" ? (
            <ParamSelect
              param="project"
              params={params}
              label={t("filters.byProject")}
              allLabel={t("filters.allProjects")}
              options={options.projects}
              icon="project"
            />
          ) : scope === "agent" ? (
            <>
              <ParamSelect
                param="agent"
                params={params}
                label={t("filters.byAgent")}
                allLabel={t("filters.allAgents")}
                options={options.agents}
                icon="agent"
              />
              <ParamSelect
                param="project"
                params={params}
                label={t("filters.byAgentLayer")}
                allLabel={t("filters.allAgentLayers")}
                options={[
                  { id: AGENT_GLOBAL_ONLY, name: t("filters.agentGlobalOnly"), icon: "global" },
                  ...options.projects,
                ]}
                icon="project"
              />
            </>
          ) : null}
          <ParamToggle param="pinned" params={params}>
            <Pin /> {t("filters.pinned")}
          </ParamToggle>
          <FiltersMenu params={params} unusedDays={options.unusedDays} />
        </>
      }
    >
      {data.rows.length ? (
        <MemoryList items={data.rows} flush />
      ) : (
        <SectionEmpty className="py-5">
          {t.rich("empty", {
            add: (chunks) => (
              <CreateMemoryDialog
                agents={options.agents}
                projects={options.projects}
                defaultScope={scope}
                defaultProjectId={isUuid(params.project) ? params.project : undefined}
                defaultAgentId={params.agent}
                trigger={
                  <button type="button" className={inlineLink}>
                    {chunks}
                  </button>
                }
              />
            ),
          })}
        </SectionEmpty>
      )}
    </MemoryPanel>
  );
}

/** Each agent's daily summary, newest day first, with its own agent and date filters. */
async function JournalTab({
  q,
  agent,
  from,
  to,
  page,
  params,
  options,
}: {
  q?: string;
  agent?: string;
  from?: string;
  to?: string;
  page: number;
  params: Record<string, string | undefined>;
  options: Options;
}) {
  const [t, f, locale, timeline, results] = await Promise.all([
    getTranslations("journals"),
    getFormat(),
    getLocale(),
    getJournalDays({ agentId: agent, from, to, page }),
    q ? listJournalSearchResults(q, agent) : Promise.resolve(null),
  ]);
  const dayLabel = (day: string) => {
    const label = f.date(parseISO(day), "EEEE, d MMMM yyyy");
    return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
  };
  const filtered = Boolean(agent || from || to);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ParamSelect
          param="agent"
          params={params}
          label={t("filters.byAgent")}
          allLabel={t("filters.allAgents")}
          options={options.agents}
          icon="agent"
        />
        <JournalDateRange params={params} />
        <p className="text-sm text-pretty text-muted-foreground sm:ml-auto sm:text-right">{t("description")}</p>
      </div>

      {results && (
        <section className="flex flex-col gap-3" aria-label={t("search.resultsAria")}>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            {t("search.resultsFor", { query: q ?? "" })}
          </h2>
          {results.length ? (
            results.map((r) => (
              <JournalEntryCard
                key={`${r.agentId}-${r.day}`}
                agentName={r.agentName ?? t("entry.deletedAgent")}
                agentAvatar={r.agentAvatar}
                summary={r.summary}
                day={dayLabel(r.day)}
                dayValue={r.day}
              />
            ))
          ) : (
            <div className={sectionCardClass}>
              <SectionEmpty className="py-5">{t("search.empty")}</SectionEmpty>
            </div>
          )}
        </section>
      )}

      {timeline.days.length ? (
        <ol className="flex flex-col gap-3">
          {timeline.days.flatMap(({ day, entries }) =>
            entries.map((e) => (
              <li key={e.id}>
                <JournalEntryCard
                  agentName={e.agentName}
                  agentAvatar={e.agentAvatar}
                  summary={e.summary}
                  consolidated={e.consolidated}
                  day={dayLabel(day)}
                  dayValue={day}
                />
              </li>
            )),
          )}
        </ol>
      ) : (
        <div className={sectionCardClass}>
          <SectionEmpty className="py-5">{filtered ? t("empty.filtered") : t("empty.none")}</SectionEmpty>
        </div>
      )}

      <ListPager
        page={timeline.page}
        hasNext={timeline.hasNext}
        href={(p) => pageHref("/memory", params, p)}
        className="border-t-0 px-0 sm:px-0"
      />
    </div>
  );
}

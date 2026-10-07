import { parseISO } from "date-fns";
import { Search } from "lucide-react";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { JournalDateRange } from "@/components/journals/journal-date-range";
import { JournalEntryCard } from "@/components/journals/journal-entry";
import { ParamSelect } from "@/components/memory/memory-filter";
import { PanelEmpty } from "@/components/memory/memory-panel";
import { QuerySearch } from "@/components/memory/memory-search";
import { PageLinks } from "@/components/memory/page-links";
import { getFormat } from "@/server/format";
import { isUuid } from "@/lib/uuid";
import { isDay } from "@/lib/day";
import { getJournalDays, getMemoryOptions, listJournalSearchResults } from "@/server/queries/memory";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("journals");
  return { title: t("meta.title") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function JournalsPage(props: PageProps<"/journals">) {
  const sp = await props.searchParams;
  const [t, f, locale] = await Promise.all([getTranslations("journals"), getFormat(), getLocale()]);
  const dayLabel = (day: string) => {
    const label = f.date(parseISO(day), "EEEE, d MMMM yyyy");
    return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
  };
  const q = one(sp.q)?.trim() || undefined;
  const agent = isUuid(one(sp.agent)) ? one(sp.agent) : undefined;
  const from = isDay(one(sp.from)) ? one(sp.from) : undefined;
  const to = isDay(one(sp.to)) ? one(sp.to) : undefined;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const params = { q, agent, from, to };

  const [options, timeline, results] = await Promise.all([
    getMemoryOptions(),
    getJournalDays({ agentId: agent, from, to, page }),
    q ? listJournalSearchResults(q, agent) : Promise.resolve(null),
  ]);
  const filtered = !!(agent || from || to);

  return (
    <PageBody>
      <PageHeader title={t("page.title")} description={t("page.description")} />

      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <QuerySearch
          key={q ?? ""}
          params={params}
          label={t("search.label")}
          placeholder={t("search.placeholder")}
          className="min-w-0 md:flex-1"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ParamSelect
            param="agent"
            params={params}
            label={t("filters.byAgent")}
            allLabel={t("filters.allAgents")}
            options={options.agents}
            icon="agent"
            className="h-10! rounded-xl sm:w-48"
          />
          <JournalDateRange params={params} className="h-10 rounded-xl" />
        </div>
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
              <PanelEmpty>{t("search.empty")}</PanelEmpty>
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
          <PanelEmpty>{filtered ? t("empty.filtered") : t("empty.none")}</PanelEmpty>
        </div>
      )}

      <PageLinks basePath="/journals" params={params} page={timeline.page} hasNext={timeline.hasNext} />
    </PageBody>
  );
}

import { parseISO } from "date-fns";
import { BookOpenIcon, CalendarIcon, FolderKanbanIcon, GlobeIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MessageResponse } from "@/components/ai-elements/message";
import { SectionCard, SectionEmpty, SectionEmptyLink, SectionList } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getFormat } from "@/server/format";
import { listAgentJournalProjects, listAgentJournals } from "@/server/queries/agents";
import { JournalProjectFilter } from "./journal-project-filter";

/** The agent's journal days, each with its project; filterable by project and searchable. */
export async function AgentJournalTab({
  agentId,
  query,
  project,
}: {
  agentId: string;
  query: string;
  /** `?project=`: a project id, "none" for work outside projects; empty for all. */
  project: string;
}) {
  const projectId = project === "none" ? null : project || undefined;
  const [t, fmt, entries, projects] = await Promise.all([
    getTranslations("agents.journal"),
    getFormat(),
    listAgentJournals(agentId, { query: query || undefined, projectId }),
    listAgentJournalProjects(agentId),
  ]);
  const base = `/agents/${agentId}?tab=activity${project ? `&project=${project}` : ""}`;

  return (
    <SectionCard
      icon={BookOpenIcon}
      title={t("title")}
      count={entries.length}
      description={t("description")}
      flush
      action={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <JournalProjectFilter
            params={{ tab: "activity", q: query || undefined, project: project || undefined }}
            projects={projects}
          />
          <form role="search" className="flex items-center gap-1.5" action={`/agents/${agentId}`}>
            <input type="hidden" name="tab" value="activity" />
            {project && <input type="hidden" name="project" value={project} />}
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                name="q"
                defaultValue={query}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchAria")}
                className="w-44 pl-8 sm:w-60"
              />
            </div>
            {query && (
              <Button variant="ghost" size="icon" asChild>
                <Link href={base} aria-label={t("reset")} title={t("reset")}>
                  <XIcon />
                </Link>
              </Button>
            )}
          </form>
        </div>
      }
    >
      {entries.length ? (
        <SectionList>
          {entries.map((j) => (
            <li key={j.key} className="flex flex-col gap-2 px-4 py-4 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <h3 className="flex items-center gap-2 text-sm font-medium capitalize">
                  <CalendarIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  {fmt.date(parseISO(j.day), "EEEE, d MMMM yyyy")}
                </h3>
                {j.project ? (
                  <Badge variant="outline" className="max-w-56 min-w-0 gap-1 font-normal" asChild>
                    <Link href={`/projects/${j.project.id}`} title={j.project.name}>
                      <FolderKanbanIcon className="text-primary" aria-hidden />
                      <span className="truncate">{j.project.name}</span>
                    </Link>
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 font-normal text-muted-foreground">
                    <GlobeIcon aria-hidden />
                    {t("noProject")}
                  </Badge>
                )}
              </div>
              <div className="min-w-0 text-sm wrap-anywhere text-foreground/90">
                <MessageResponse>{j.summary}</MessageResponse>
              </div>
            </li>
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>
          {query ? (
            <>
              {t("noResults", { query })} <SectionEmptyLink href={base}>{t("all")}</SectionEmptyLink>
            </>
          ) : project ? (
            <>
              {t("emptyFiltered")}{" "}
              <SectionEmptyLink href={`/agents/${agentId}?tab=activity`}>{t("allProjectsLink")}</SectionEmptyLink>
            </>
          ) : (
            t("empty")
          )}
        </SectionEmpty>
      )}
    </SectionCard>
  );
}

import type { AgentKind } from "@abotica/db";
import { ArrowRightIcon, BookOpenIcon, ChevronRightIcon, FolderKanbanIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, sectionCardClass, SectionEmpty, SectionEmptyLink } from "@/components/app/section-card";
import { ProjectStatusBadge } from "@/components/projects/project-badges";
import { ManagerBadge, MemberActivityStats } from "@/components/projects/team-parts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type AgentProject, listAgentProjects } from "@/server/queries/agents";

/**
 * The projects an agent is on: one card each, with its role there and what it did and learned there.
 * Its own (profession) memory stays on the Memory tab.
 */
export async function AgentProjectsTab({ agentId, kind }: { agentId: string; kind: AgentKind }) {
  const [projects, t] = await Promise.all([listAgentProjects(agentId), getTranslations("agents.projects")]);
  // A manager's projects are the ones it leads.
  const leads = kind === "manager";
  const description = leads ? t("ledDescription") : t("description");

  if (!projects.length) {
    return (
      <SectionCard icon={FolderKanbanIcon} title={t("title")} description={description} flush>
        <SectionEmpty>
          {t.rich(leads ? "ledEmpty" : "empty", {
            link: (chunks) => <SectionEmptyLink href="/projects">{chunks}</SectionEmptyLink>,
          })}
        </SectionEmpty>
      </SectionCard>
    );
  }

  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {projects.map((p) => (
          // A manager leads every project listed: no badge to repeat it.
          <ProjectCard key={p.id} agentId={agentId} project={p} managerBadge={!leads} />
        ))}
      </ul>
    </section>
  );
}

async function ProjectCard({
  agentId,
  project,
  managerBadge,
}: {
  agentId: string;
  project: AgentProject;
  managerBadge: boolean;
}) {
  const t = await getTranslations("agents.projects");
  const teamHref = `/projects/${project.id}?tab=team`;
  return (
    <li className={cn(sectionCardClass, "flex min-w-0 flex-col gap-4 p-4 sm:p-5")}>
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary dark:bg-primary/15"
        >
          <FolderKanbanIcon className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/projects/${project.id}`}
            title={project.name}
            className="min-w-0 truncate font-medium underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            {project.name}
          </Link>
          {managerBadge && project.isManager && <ManagerBadge />}
          {project.status !== "active" && <ProjectStatusBadge status={project.status} />}
        </div>
      </div>

      <MemberActivityStats activity={project.activity} />

      {project.memories.length > 0 && (
        <details className="group/learned rounded-xl border border-border/60">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors outline-none select-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open/learned:rotate-90"
              aria-hidden
            />
            {t("learned", { count: project.memories.length })}
          </summary>
          <ul className="divide-y divide-border/60 border-t border-border/60">
            {project.memories.map((m) => (
              <li key={m.id} className="flex flex-col gap-1 px-3 py-2.5">
                <p className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{m.content}</p>
                <RelativeTime date={m.updatedAt} className="text-xs text-muted-foreground" />
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-auto flex justify-end gap-1 border-t border-border/60 pt-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/agents/${agentId}?tab=journal&project=${project.id}`}>
            <BookOpenIcon /> {t("openJournal")}
          </Link>
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href={teamHref}>
            {t("openTeam")} <ArrowRightIcon />
          </Link>
        </Button>
      </div>
    </li>
  );
}

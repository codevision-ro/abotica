import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  CrownIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  LayoutDashboardIcon,
  LibraryIcon,
  ListTodoIcon,
  PencilIcon,
  UsersIcon,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { TabNav } from "@/components/app/tab-nav";
import { StartConversationButton } from "@/components/chat/start-conversation";
import { OwnedMemories } from "@/components/memory/owned-memories";
import { ProjectStatusBadge } from "@/components/projects/project-badges";
import { ProjectKnowledge } from "@/components/projects/project-knowledge";
import { ProjectOverview } from "@/components/projects/project-overview";
import { ProjectRepos } from "@/components/projects/project-repos";
import { ProjectStatusMenu } from "@/components/projects/project-status-menu";
import { ProjectTasks } from "@/components/projects/project-tasks";
import { ProjectTeamTab } from "@/components/projects/project-team";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import { listPreviewRows } from "@/server/queries/previews";
import { listOwnerMemories } from "@/server/queries/memory";
import {
  getProject,
  getProjectOverview,
  getProjectTeam,
  listHireTemplates,
  listKnowledgeItems,
  listLeadableAgents,
  listProjectRepos,
  listProjectTasks,
  listTeamCandidates,
  type ProjectDetail,
} from "@/server/queries/projects";

const TABS = ["overview", "tasks", "team", "knowledge", "repos"] as const;

type Tab = (typeof TABS)[number];

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  overview: <LayoutDashboardIcon />,
  tasks: <ListTodoIcon />,
  team: <UsersIcon />,
  knowledge: <LibraryIcon />,
  repos: <FolderGitIcon />,
};

/** Tabs that moved: old links land where their content lives now (the project's keys are in Settings > Keys). */
const MOVED_TABS: Record<string, (id: string) => string> = {
  memory: (id) => `/projects/${id}?tab=knowledge`,
  previews: (id) => `/projects/${id}`,
  secrets: (id) => `/settings/keys?project=${id}`,
};

async function load(id: string) {
  return isUuid(id) ? getProject(id) : null;
}

export async function generateMetadata(props: PageProps<"/projects/[id]">): Promise<Metadata> {
  const project = await load((await props.params).id);
  if (project) return { title: project.name };
  const t = await getTranslations("projects");
  return { title: t("meta.fallbackTitle") };
}

export default async function ProjectPage(props: PageProps<"/projects/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const project = await load(id);
  if (!project) notFound();

  const moved = typeof sp.tab === "string" && Object.hasOwn(MOVED_TABS, sp.tab) ? MOVED_TABS[sp.tab] : undefined;
  if (moved) redirect(moved(project.id));
  const tab: Tab = TABS.some((t) => t === sp.tab) ? (sp.tab as Tab) : "overview";
  const t = await getTranslations("projects");
  const tc = await getTranslations("common");

  return (
    <PageBody>
      <BackLink href="/projects">{t("detail.back")}</BackLink>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex size-14 shrink-0 items-center justify-center self-start rounded-2xl bg-primary/8 text-primary sm:self-center dark:bg-primary/15">
          <FolderKanbanIcon className="size-7" aria-hidden />
        </span>
        {/* basis keeps the title readable: below it the actions wrap to their own row. */}
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" title={project.name}>
              {project.name}
            </h1>
            <ProjectStatusBadge status={project.status} />
          </div>
          {project.description && (
            <p
              className="line-clamp-2 max-w-3xl text-sm text-pretty text-muted-foreground wrap-anywhere"
              title={project.description}
            >
              {project.description}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectStatusMenu projectId={project.id} status={project.status} />
          <Button variant="outline" asChild>
            <Link href={`/projects/${project.id}/settings`}>
              <PencilIcon />
              {tc("actions.edit")}
            </Link>
          </Button>
          {/* Conversations here are with the manager; without one, setting it up is the next step. */}
          {project.managerAgentId ? (
            <StartConversationButton input={{ projectId: project.id }} variant={tab === "team" ? "outline" : "default"}>
              {t("detail.chat")}
            </StartConversationButton>
          ) : (
            tab !== "team" && (
              <Button asChild>
                <Link href={`/projects/${project.id}?tab=team`}>
                  <CrownIcon />
                  {t("detail.chooseManager")}
                </Link>
              </Button>
            )
          )}
        </div>
      </div>

      <TabNav
        items={TABS.map((value) => ({
          href: value === "overview" ? `/projects/${project.id}` : `/projects/${project.id}?tab=${value}`,
          label: t(`detail.tabs.${value}`),
          icon: TAB_ICONS[value],
          active: value === tab,
        }))}
      />
      {tab === "overview" && <OverviewTab project={project} />}
      {tab === "team" && <TeamTab project={project} />}
      {tab === "tasks" && <ProjectTasks projectId={project.id} tasks={await listProjectTasks(project.id)} />}
      {tab === "knowledge" && <KnowledgeTab projectId={project.id} />}
      {tab === "repos" && <ProjectRepos projectId={project.id} repos={await listProjectRepos(project.id)} />}
    </PageBody>
  );
}

async function OverviewTab({ project }: { project: ProjectDetail }) {
  const [overview, team, previews] = await Promise.all([
    getProjectOverview(project.id),
    getProjectTeam(project),
    listPreviewRows(project.id),
  ]);
  return <ProjectOverview project={project} overview={overview} team={team} previews={previews} />;
}

/** What the team knows: the project's memory, then the documents its agents can search. */
async function KnowledgeTab({ projectId }: { projectId: string }) {
  const [memories, items] = await Promise.all([listOwnerMemories({ projectId }), listKnowledgeItems(projectId)]);
  return (
    <div className="flex flex-col gap-6">
      <OwnedMemories owner={{ projectId }} memories={memories} />
      <ProjectKnowledge projectId={projectId} items={items} />
    </div>
  );
}

async function TeamTab({ project }: { project: ProjectDetail }) {
  const [team, candidates, templates, managers] = await Promise.all([
    getProjectTeam(project),
    listTeamCandidates(project.id),
    listHireTemplates(),
    listLeadableAgents(),
  ]);
  return (
    <ProjectTeamTab projectId={project.id} team={team} candidates={candidates} templates={templates} managers={managers} />
  );
}

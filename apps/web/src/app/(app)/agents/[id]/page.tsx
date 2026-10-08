import { snapshotOf } from "@abotica/core";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  CopyPlusIcon,
  CpuIcon,
  FolderKanbanIcon,
  HistoryIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AgentActions, AgentEnabledSwitch } from "@/components/agents/agent-actions";
import { KindBadge } from "@/components/agents/agent-card";
import { AgentForm } from "@/components/agents/agent-form";
import { AgentProjectsTab } from "@/components/agents/agent-projects-tab";
import { AgentJournalTab } from "@/components/agents/agent-journal-tab";
import { AgentRunsTab } from "@/components/agents/agent-runs-tab";
import { AgentSchedulesTab } from "@/components/agents/agent-schedules-tab";
import { AgentVersionsTab } from "@/components/agents/agent-versions-tab";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { TabNav } from "@/components/app/tab-nav";
import { PageBody } from "@/components/app/page-header";
import { StartConversationButton } from "@/components/chat/start-conversation";
import { OwnedMemories } from "@/components/memory/owned-memories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import { getAgent, getAgentFormOptions, listAgentProjects } from "@/server/queries/agents";
import { getPinnedUsage, listOwnerMemories } from "@/server/queries/memory";

const TABS = ["config", "versions", "journal", "memory", "projects", "runs", "schedules"] as const;

type TabId = (typeof TABS)[number];

async function load(id: string) {
  return isUuid(id) ? getAgent(id) : null;
}

export async function generateMetadata(props: PageProps<"/agents/[id]">): Promise<Metadata> {
  const data = await load((await props.params).id);
  if (data) return { title: data.agent.name };
  const t = await getTranslations("agents.meta");
  return { title: t("fallback") };
}

export default async function AgentPage(props: PageProps<"/agents/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  // The form options are loaded alongside the agent when the configuration tab is (likely) shown.
  const maybeConfig = !TABS.some((tab) => tab !== "config" && tab === sp.tab);
  const [data, configOptions, t] = await Promise.all([
    load(id),
    maybeConfig ? getAgentFormOptions() : null,
    getTranslations("agents"),
  ]);
  if (!data) notFound();
  const { agent, skillIds, mcpServerIds, projectIds } = data;

  // The super agent and templates never join a project, so they have no Projects tab.
  const joinsProjects = agent.kind !== "orchestrator" && !agent.isTemplate;
  const tabs = TABS.filter((id) => id !== "projects" || joinsProjects);
  const tab: TabId = tabs.some((id) => id === sp.tab) ? (sp.tab as TabId) : "config";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  // Journal tab filter: a project id, or "none" for work outside projects.
  const journalProject = typeof sp.project === "string" && (sp.project === "none" || isUuid(sp.project)) ? sp.project : "";
  const v = typeof sp.v === "string" ? Number(sp.v) : undefined;

  const tabIcons: Record<TabId, React.ReactNode> = {
    config: <SlidersHorizontalIcon />,
    versions: <HistoryIcon />,
    journal: <BookOpenIcon />,
    memory: <BrainIcon />,
    projects: <FolderKanbanIcon />,
    runs: <ActivityIcon />,
    schedules: <CalendarClockIcon />,
  };

  return (
    <PageBody>
      <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
        <Link href="/agents">
          <ArrowLeftIcon /> {t("detail.back")}
        </Link>
      </Button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <AgentAvatar avatar={agent.avatar} size="2xl" />
        {/* basis keeps the title readable: below it the actions wrap to their own row. */}
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight" title={agent.name}>
              {agent.name}
            </h1>
            <KindBadge kind={agent.kind} />
            {agent.isTemplate && <Badge variant="outline">{t("card.template")}</Badge>}
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground wrap-anywhere" title={agent.role || undefined}>
            {agent.role || t("card.noRole")}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5" title={t("detail.model")}>
              <CpuIcon className="size-3.5 shrink-0" aria-hidden />
              {agent.provider && agent.model ? (
                <span className="truncate font-mono">
                  {agent.provider}/{agent.model}
                </span>
              ) : (
                t("card.defaultModel")
              )}
            </span>
            <span className="tabular inline-flex items-center gap-1.5" title={t("detail.version")}>
              <HistoryIcon className="size-3.5" aria-hidden />v{agent.version}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AgentEnabledSwitch id={agent.id} enabled={agent.enabled} locked={agent.kind === "orchestrator"} withLabel />
          {agent.isTemplate && (
            <Button variant="outline" asChild>
              <Link href={`/agents/new?template=${agent.slug}`}>
                <CopyPlusIcon /> {t("detail.useTemplate")}
              </Link>
            </Button>
          )}
          {/* On the configuration tab the form's save button is the primary action. */}
          <StartConversationButton
            input={{ agentId: agent.id }}
            variant={tab === "config" ? "outline" : "default"}
            disabled={!agent.enabled}
          >
            {t("detail.chat")}
          </StartConversationButton>
          <AgentActions id={agent.id} name={agent.name} isOrchestrator={agent.kind === "orchestrator"} />
        </div>
      </div>

      <TabNav
        items={tabs.map((id) => ({
          href: `/agents/${agent.id}?tab=${id}`,
          label: t(`detail.tabs.${id}`),
          icon: tabIcons[id],
          active: id === tab,
        }))}
      />

      {tab === "config" && (
        <AgentForm
          key={`${agent.id}-${agent.version}`}
          mode={{ kind: "edit", agentId: agent.id }}
          isTemplate={agent.isTemplate}
          options={configOptions ?? (await getAgentFormOptions())}
          initial={{
            name: agent.name,
            role: agent.role,
            avatar: agent.avatar,
            kind: agent.kind,
            systemPrompt: agent.systemPrompt,
            provider: agent.provider,
            model: agent.model,
            fallbacks: agent.fallbacks,
            reasoningEffort: agent.reasoningEffort,
            permissions: agent.permissions,
            limits: agent.limits,
            skillIds,
            mcpServerIds,
            projectIds,
          }}
        />
      )}
      {tab === "versions" && (
        <AgentVersionsTab
          agentId={agent.id}
          currentVersion={agent.version}
          current={snapshotOf(agent, skillIds, mcpServerIds)}
          selected={v}
        />
      )}
      {tab === "journal" && <AgentJournalTab agentId={agent.id} query={q} project={journalProject} />}
      {tab === "memory" && (
        <OwnedMemories
          owner={{ agentId: agent.id }}
          memories={await listOwnerMemories({ agentId: agent.id })}
          pinnedUsage={await getPinnedUsage({ agentId: agent.id })}
          projects={(await listAgentProjects(agent.id)).map((p) => ({ id: p.id, name: p.name }))}
        />
      )}
      {tab === "projects" && <AgentProjectsTab agentId={agent.id} kind={agent.kind} />}
      {tab === "runs" && <AgentRunsTab agentId={agent.id} />}
      {tab === "schedules" && <AgentSchedulesTab agentId={agent.id} />}
    </PageBody>
  );
}

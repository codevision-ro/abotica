import { snapshotOf } from "@abotica/core";
import {
  ActivityIcon,
  BrainIcon,
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
import { BackLink } from "@/components/app/back-link";
import { AgentActions, AgentEnabledSwitch } from "@/components/agents/agent-actions";
import { KindBadge } from "@/components/agents/agent-card";
import { AgentActivityTab } from "@/components/agents/agent-activity-tab";
import { AgentForm } from "@/components/agents/agent-form";
import { AgentProjectsTab } from "@/components/agents/agent-projects-tab";
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

const TABS = ["config", "activity", "memory", "projects"] as const;

/** The tabs plus History, reached from Configuration (which stays highlighted while it shows). */
type TabId = (typeof TABS)[number] | "history";

/** Tabs of earlier versions of this page, so old links still land where they meant. */
const LEGACY_TABS: Record<string, TabId> = {
  versions: "history",
  runs: "activity",
  journal: "activity",
  schedules: "activity",
};

function tabOf(param: unknown, tabs: readonly TabId[]): TabId {
  const tab = typeof param === "string" ? (LEGACY_TABS[param] ?? param) : "";
  return tabs.some((id) => id === tab) || tab === "history" ? (tab as TabId) : "config";
}

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
  const maybeConfig = tabOf(sp.tab, TABS) === "config";
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
  const tab = tabOf(sp.tab, tabs);
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  // Journal filter of the Activity tab: a project id, or "none" for work outside projects.
  const journalProject = typeof sp.project === "string" && (sp.project === "none" || isUuid(sp.project)) ? sp.project : "";
  const v = typeof sp.v === "string" ? Number(sp.v) : undefined;

  const tabIcons: Record<(typeof TABS)[number], React.ReactNode> = {
    config: <SlidersHorizontalIcon />,
    activity: <ActivityIcon />,
    memory: <BrainIcon />,
    projects: <FolderKanbanIcon />,
  };

  return (
    <PageBody>
      <BackLink href="/agents">{t("detail.back")}</BackLink>

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
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AgentEnabledSwitch id={agent.id} enabled={agent.enabled} locked={agent.kind === "orchestrator"} withLabel />
          {(tab === "config" || tab === "history") && (
            <Button variant="ghost" asChild>
              <Link href={`/agents/${agent.id}?tab=${tab === "history" ? "config" : "history"}`} scroll={false}>
                {tab === "history" ? <SlidersHorizontalIcon /> : <HistoryIcon />}
                {tab === "history" ? t("detail.backToConfig") : t("detail.history")}
              </Link>
            </Button>
          )}
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
          active: id === tab || (id === "config" && tab === "history"),
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
      {tab === "history" && (
        <AgentVersionsTab
          agentId={agent.id}
          currentVersion={agent.version}
          current={snapshotOf(agent, skillIds, mcpServerIds)}
          selected={v}
        />
      )}
      {tab === "activity" && <AgentActivityTab agentId={agent.id} query={q} project={journalProject} />}
      {tab === "memory" && (
        <OwnedMemories
          owner={{ agentId: agent.id }}
          memories={await listOwnerMemories({ agentId: agent.id })}
          pinnedUsage={await getPinnedUsage({ agentId: agent.id })}
          projects={(await listAgentProjects(agent.id)).map((p) => ({ id: p.id, name: p.name }))}
        />
      )}
      {tab === "projects" && <AgentProjectsTab agentId={agent.id} kind={agent.kind} />}
    </PageBody>
  );
}

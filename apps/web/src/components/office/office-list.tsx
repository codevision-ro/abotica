"use client";

import type { OfficeAgent, OfficeInteraction, OfficeSeat, OfficeState } from "@abotica/core/office";
import { ActivityIcon, BriefcaseBusinessIcon, CoffeeIcon, CrownIcon, FolderKanbanIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionEmpty, SectionList, sectionCardClass } from "@/components/app/section-card";
import { ProjectStatusBadge } from "@/components/projects/project-badges";
import { cn } from "@/lib/utils";
import type { OfficeAgentTarget } from "./office-scene-props";
import { OfficeFeed } from "./office-feed";
import { OfficeStatusChip, officeSeatDetail, useOfficeLabels } from "./office-status";

type Select = (target: OfficeAgentTarget) => void;

/** The office without 3D, for phones and reduced motion: the rooms as cards, then the feed. */
export function OfficeList({
  state,
  onSelectAgent,
  onSelectRoom,
  onSelectInteraction,
}: {
  state: OfficeState;
  onSelectAgent: Select;
  onSelectRoom: (projectId: string) => void;
  onSelectInteraction?: (interaction: OfficeInteraction) => void;
}) {
  const t = useTranslations("office");
  const labels = useOfficeLabels();
  const byId = new Map(state.agents.map((a) => [a.id, a]));
  const superAgent = state.superAgent ? byId.get(state.superAgent.agentId) : undefined;
  const lounge = state.loungeIds.flatMap((id) => byId.get(id) ?? []);
  const empty = !superAgent && !state.rooms.length && !lounge.length;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      {empty ? (
        <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>{t("list.empty")}</p>
      ) : (
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
          {superAgent && state.superAgent && (
            <SectionCard icon={BriefcaseBusinessIcon} title={labels.place("superAgent")} flush>
              <SectionList>
                <MemberRow
                  agent={superAgent}
                  seat={state.superAgent.seat}
                  onSelect={() => onSelectAgent({ agentId: superAgent.id, projectId: null })}
                />
              </SectionList>
            </SectionCard>
          )}

          {state.rooms.map((room) => {
            const members = room.memberIds.flatMap((id) => byId.get(id) ?? []);
            return (
              <SectionCard
                key={room.projectId}
                icon={FolderKanbanIcon}
                title={
                  <button
                    type="button"
                    onClick={() => onSelectRoom(room.projectId)}
                    className="rounded-sm text-left wrap-anywhere outline-none hover:underline hover:underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {room.name}
                  </button>
                }
                action={room.status === "paused" ? <ProjectStatusBadge status="paused" /> : undefined}
                flush
              >
                {members.length ? (
                  <SectionList>
                    {members.map((agent) => (
                      <MemberRow
                        key={agent.id}
                        agent={agent}
                        manager={agent.id === room.managerAgentId}
                        seat={room.seats.find((s) => s.agentId === agent.id) ?? null}
                        idleDetail={t("list.inLounge")}
                        onSelect={() => onSelectAgent({ agentId: agent.id, projectId: room.projectId })}
                      />
                    ))}
                  </SectionList>
                ) : (
                  <SectionEmpty>{t("list.noMembers")}</SectionEmpty>
                )}
              </SectionCard>
            );
          })}

          <SectionCard icon={CoffeeIcon} title={labels.place("lounge")} count={lounge.length} flush>
            {lounge.length ? (
              <SectionList>
                {lounge.map((agent) => (
                  <MemberRow
                    key={agent.id}
                    agent={agent}
                    seat={null}
                    onSelect={() => onSelectAgent({ agentId: agent.id, projectId: null })}
                  />
                ))}
              </SectionList>
            ) : (
              <SectionEmpty>{t("list.loungeEmpty")}</SectionEmpty>
            )}
          </SectionCard>
        </div>
      )}

      <SectionCard
        icon={ActivityIcon}
        title={t("feed.title")}
        count={state.interactions.length}
        flush
        className="lg:sticky lg:top-0"
      >
        <OfficeFeed state={state} onSelect={onSelectInteraction} />
      </SectionCard>
    </div>
  );
}

/** One agent: avatar centered next to name and role, then its status chip and what it is on. */
function MemberRow({
  agent,
  seat,
  manager,
  idleDetail,
  onSelect,
}: {
  agent: OfficeAgent;
  seat: OfficeSeat | null;
  manager?: boolean;
  /** Shown next to the idle chip, e.g. "In the lounge" for a member without a desk. */
  idleDetail?: string;
  onSelect: () => void;
}) {
  const tTeam = useTranslations("team");
  const labels = useOfficeLabels();
  const detail = seat ? officeSeatDetail(seat, labels) : idleDetail;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
      >
        <AgentAvatar avatar={agent.avatar} size="lg" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            {manager && <CrownIcon className="size-3.5 shrink-0 text-primary" aria-label={tTeam("manager")} />}
            {agent.role && <span className="truncate text-xs text-muted-foreground">{agent.role}</span>}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <OfficeStatusChip status={seat?.status ?? "idle"} />
            {detail && (
              <span className="truncate text-xs text-muted-foreground" title={detail}>
                {detail}
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

import { CrownIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionEmpty } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { HireTemplate, JoinableAgent, ProjectTeam, TeamMember } from "@/server/queries/projects";
import { AddTeamMembersDialog } from "./project-team-add-dialog";
import { ChangeManagerMenu, NoManagerActions, SpecialistMenu } from "./project-team-actions";
import { MemberActivityStats } from "./team-parts";

/**
 * The project's team: the manager on top (it answers in the project's conversations and splits the work),
 * then the specialists, each with what it did and learned here.
 */
export async function ProjectTeamTab({
  projectId,
  team,
  candidates,
  templates,
}: {
  projectId: string;
  team: ProjectTeam;
  candidates: JoinableAgent[];
  templates: HireTemplate[];
}) {
  const t = await getTranslations("team");
  const { manager, specialists } = team;
  // Core lets only enabled agents lead a project.
  const canLead = specialists.filter((m) => m.enabled);

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        icon={CrownIcon}
        title={t("managerTitle")}
        description={t("managerDescription")}
        action={manager && <ChangeManagerMenu projectId={projectId} specialists={canLead} />}
      >
        {manager ? (
          <MemberIdentity member={manager} size="xl" />
        ) : (
          <div className="flex flex-col gap-4 rounded-xl border border-dashed p-4 sm:flex-row sm:items-center sm:p-5">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary dark:bg-primary/15">
              <CrownIcon className="size-6" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-medium">{t("noManagerTitle")}</p>
              <p className="text-sm text-pretty text-muted-foreground">{t("noManagerDescription")}</p>
            </div>
            <NoManagerActions projectId={projectId} members={canLead} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        icon={UsersIcon}
        title={t("specialistsTitle")}
        count={specialists.length}
        description={t("specialistsDescription")}
        flush={!specialists.length}
        action={
          <AddTeamMembersDialog
            projectId={projectId}
            candidates={candidates}
            templates={templates}
            primary={Boolean(manager)}
          />
        }
      >
        {specialists.length ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {specialists.map((m) => (
              <li
                key={m.id}
                className="flex min-w-0 items-start gap-2 rounded-xl border border-border/60 bg-background/60 p-4 dark:bg-input/20"
              >
                <MemberIdentity member={m} size="lg" className="flex-1" />
                <SpecialistMenu projectId={projectId} member={m} />
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty>{t("noSpecialists")}</SectionEmpty>
        )}
      </SectionCard>
    </div>
  );
}

/** Avatar, name (to the agent's page), role and activity here. */
async function MemberIdentity({ member, size, className }: { member: TeamMember; size: "lg" | "xl"; className?: string }) {
  const t = await getTranslations("team");
  const tc = await getTranslations("common");
  return (
    <div className={cn("flex min-w-0 gap-3", size === "xl" ? "items-center" : "items-start", className)}>
      <AgentAvatar avatar={member.avatar} size={size} className={cn(!member.enabled && "opacity-60")} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={`/agents/${member.id}`}
              title={member.name}
              className={cn(
                "min-w-0 truncate font-medium underline-offset-2 outline-none hover:underline focus-visible:underline",
                !member.enabled && "text-muted-foreground",
              )}
            >
              {member.name}
            </Link>
            {!member.enabled && (
              <Badge variant="secondary" className="shrink-0 font-normal">
                {tc("states.disabled")}
              </Badge>
            )}
          </div>
          <p className="truncate text-sm text-muted-foreground" title={member.role || undefined}>
            {member.role || t("noRole")}
          </p>
        </div>
        <MemberActivityStats activity={member.activity} />
      </div>
    </div>
  );
}

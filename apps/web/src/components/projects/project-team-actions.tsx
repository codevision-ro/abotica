"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { ArrowLeftRightIcon, ChevronDownIcon, CrownIcon, EllipsisIcon, SparklesIcon, UserMinusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  createProjectManager,
  ensureProjectManager,
  removeProjectMember,
  setProjectManager,
} from "@/server/actions/projects";

type Member = { id: string; name: string; avatar: AgentAvatarValue; role: string };

/** Runs a team action in a transition and toasts its outcome. */
function useTeamAction() {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      toast.success(success);
    });
  return { run, pending };
}

/** Menu items to pick one of the managers as the project's manager. */
function ManagerChoices({ managers, onPick }: { managers: Member[]; onPick: (manager: Member) => void }) {
  return managers.map((m) => (
    <DropdownMenuItem key={m.id} className="gap-2.5" onSelect={() => onPick(m)}>
      <AgentAvatar avatar={m.avatar} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{m.name}</span>
        {m.role && <span className="block truncate text-xs text-muted-foreground">{m.role}</span>}
      </span>
    </DropdownMenuItem>
  ));
}

/**
 * "Change manager" on the manager card: hands the lead to another manager (one can lead several
 * projects), or to a new one created from the template. Team members are specialists and never lead.
 */
export function ChangeManagerMenu({ projectId, managers }: { projectId: string; managers: Member[] }) {
  const t = useTranslations("team");
  const { run, pending } = useTeamAction();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {pending ? <Spinner /> : <ArrowLeftRightIcon />}
          {t("changeManager")}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t("chooseManager")}</DropdownMenuLabel>
        {managers.length ? (
          <ManagerChoices
            managers={managers}
            onPick={(m) =>
              run(() => setProjectManager({ projectId, agentId: m.id }), t("toasts.managerChanged", { name: m.name }))
            }
          />
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{t("noOtherManagers")}</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run(() => createProjectManager({ projectId }), t("toasts.managerCreated"))}>
          <SparklesIcon />
          {t("createNewManager")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The empty manager slot: create one from the template (primary) or choose a manager you already have. */
export function NoManagerActions({ projectId, managers }: { projectId: string; managers: Member[] }) {
  const t = useTranslations("team");
  const { run, pending } = useTeamAction();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={pending} onClick={() => run(() => ensureProjectManager({ projectId }), t("toasts.managerCreated"))}>
        {pending ? <Spinner /> : <SparklesIcon />}
        {t("createManager")}
      </Button>
      {managers.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={pending}>
              <CrownIcon />
              {t("chooseExisting")}
              <ChevronDownIcon className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{t("chooseManager")}</DropdownMenuLabel>
            <ManagerChoices
              managers={managers}
              onPick={(m) =>
                run(() => setProjectManager({ projectId, agentId: m.id }), t("toasts.managerChanged", { name: m.name }))
              }
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** A specialist's menu: take it off the team (after a confirmation). Specialists never lead a project. */
export function SpecialistMenu({ projectId, member }: { projectId: string; member: Member }) {
  const t = useTranslations("team");
  const [confirming, setConfirming] = useState(false);
  const { run, pending } = useTeamAction();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            aria-label={t("memberActions", { name: member.name })}
            className="relative z-10 text-muted-foreground"
          >
            {pending ? <Spinner /> : <EllipsisIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <UserMinusIcon />
            {t("remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        icon={UserMinusIcon}
        title={t("removeTitle", { name: member.name })}
        description={t("removeDescription", { name: member.name })}
        titleClassName="wrap-anywhere"
        confirm={t("removeConfirm")}
        destructive
        onConfirm={() =>
          run(() => removeProjectMember({ projectId, agentId: member.id }), t("toasts.removed", { name: member.name }))
        }
      />
    </>
  );
}

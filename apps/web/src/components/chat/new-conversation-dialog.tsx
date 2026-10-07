"use client";

import { FolderKanbanIcon, GlobeIcon, MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ManagerBadge } from "@/components/projects/team-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { ChatAgent, ChatProject } from "@/server/queries/chat";
import { NO_PROJECT } from "@/lib/conversation-filter";
import { useStartConversation } from "./start-conversation";

/**
 * Who a conversation can be with: in a project only its team (manager first), outside one any agent (the
 * super agent first). Disabled agents cannot answer, so they are left out.
 */
function agentsFor(project: ChatProject | undefined, agents: ChatAgent[]) {
  const enabled = agents.filter((a) => a.enabled);
  if (!project) return enabled;
  return enabled
    .filter((a) => project.memberIds.includes(a.id))
    .sort((a, b) => Number(b.id === project.managerAgentId) - Number(a.id === project.managerAgentId));
}

/** The default partner: the project's manager, or the super agent outside a project; else the first one. */
function defaultAgentId(project: ChatProject | undefined, options: ChatAgent[]) {
  const preferred = project ? project.managerAgentId : options.find((a) => a.isOrchestrator)?.id;
  return options.find((a) => a.id === preferred)?.id ?? options[0]?.id ?? "";
}

/** Starts a conversation: pick where it happens (a project or none), then who it is with. */
export function NewConversationDialog({
  open,
  onOpenChange,
  agents,
  projects,
  initialProjectId,
  hrefFor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: ChatAgent[];
  projects: ChatProject[];
  /** Preselected project, e.g. the one the conversation list is filtered by. */
  initialProjectId?: string;
  /** Where the new conversation opens; `/chat/<id>` by default. */
  hrefFor?: (id: string, projectId: string | null) => string;
}) {
  const t = useTranslations("chat.newConversation");
  const tc = useTranslations("common.actions");
  const { start, pending } = useStartConversation();
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const project = projects.find((p) => p.id === projectId);
  const options = agentsFor(project, agents);
  const [agentId, setAgentId] = useState("");

  // Every opening starts from the list's project and that project's default partner.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) pickProject(projects.find((p) => p.id === initialProjectId)?.id ?? NO_PROJECT);
  }

  function pickProject(id: string) {
    const next = projects.find((p) => p.id === id);
    setProjectId(id);
    setAgentId(defaultAgentId(next, agentsFor(next, agents)));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId) return;
    const projectId = project?.id ?? null;
    start(
      { agentId, projectId: projectId ?? undefined },
      {
        onStarted: () => onOpenChange(false),
        href: hrefFor && ((id) => hrefFor(id, projectId)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="new-conversation-project">{t("projectLabel")}</FieldLabel>
            <Select value={projectId} onValueChange={pickProject}>
              <SelectTrigger
                id="new-conversation-project"
                className="w-full *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-2rem)]">
                <SelectItem value={NO_PROJECT}>
                  <GlobeIcon className="text-muted-foreground" />
                  <span className="truncate">{t("noProject")}</span>
                </SelectItem>
                {projects.length > 0 && <SelectSeparator />}
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
                    <FolderKanbanIcon className="text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{project ? t("projectHint") : t("noProjectHint")}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel id="new-conversation-agent">{t("agentLabel")}</FieldLabel>
            {options.length ? (
              <RadioGroup
                value={agentId}
                onValueChange={setAgentId}
                aria-labelledby="new-conversation-agent"
                className="-mx-1 flex max-h-[40vh] flex-col gap-2 overflow-y-auto px-1 py-0.5"
              >
                {options.map((a) => (
                  <label
                    key={a.id}
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5 dark:bg-input/20 dark:has-data-[state=checked]:bg-primary/10"
                  >
                    <RadioGroupItem value={a.id} />
                    <AgentAvatar avatar={a.avatar} size="lg" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium" title={a.name}>
                          {a.name}
                        </span>
                        {a.id === project?.managerAgentId && <ManagerBadge className="shrink-0" />}
                        {a.isOrchestrator && (
                          <Badge variant="secondary" className="shrink-0">
                            {t("superAgent")}
                          </Badge>
                        )}
                      </span>
                      {a.role && (
                        <span className="truncate text-xs text-muted-foreground" title={a.role}>
                          {a.role}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            ) : (
              <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
                {t.rich("noTeam", {
                  link: (chunks) => (
                    <Link
                      href={`/projects/${projectId}?tab=team`}
                      onClick={() => onOpenChange(false)}
                      className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending || !agentId}>
              {pending ? <Spinner /> : <MessageSquareIcon />}
              {t("start")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

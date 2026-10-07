"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createMemory } from "@/server/actions/memory";

type Option = { id: string; name: string; avatar?: AgentAvatarValue | null };
type Scope = "global" | "project" | "agent";

export function CreateMemoryDialog({
  agents,
  projects,
  defaultScope = "global",
  defaultProjectId,
  defaultAgentId,
  trigger,
}: {
  agents: Option[];
  projects: Option[];
  defaultScope?: Scope;
  defaultProjectId?: string;
  defaultAgentId?: string;
  /** Replaces the default "Add" button, e.g. with an outline one or an inline link. */
  trigger?: React.ReactElement;
}) {
  const t = useTranslations("memory");
  const tCommon = useTranslations("common.actions");
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>(defaultScope);
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  const [content, setContent] = useState("");
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    if (next) {
      setScope(defaultScope);
      setProjectId(defaultProjectId ?? "");
      setAgentId(defaultAgentId ?? "");
      setContent("");
    }
    setOpen(next);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await createMemory({
        scope,
        content,
        projectId: scope === "project" ? projectId || null : null,
        agentId: scope === "agent" ? agentId || null : null,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("dialog.created"));
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus /> {t("dialog.add")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        // A stray tap next to the dialog must not throw away typed text; Escape and the close button still work.
        onInteractOutside={(e) => content.trim() && e.preventDefault()}
      >
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{t("dialog.createTitle")}</DialogTitle>
            <DialogDescription>{t("dialog.createDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="memory-scope">{t("dialog.scope")}</FieldLabel>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger id="memory-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">{t("scopes.global")}</SelectItem>
                  <SelectItem value="project">{t("scopes.project")}</SelectItem>
                  <SelectItem value="agent">{t("scopes.agent")}</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>{t(`dialog.scopeHelp.${scope}`)}</FieldDescription>
            </Field>
            {scope === "project" && (
              <Field>
                <FieldLabel htmlFor="memory-project">{t("dialog.project")}</FieldLabel>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="memory-project" className="w-full">
                    <SelectValue placeholder={projects.length ? t("dialog.chooseProject") : t("dialog.noProjects")} />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-2rem)]">
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="*:[span]:last:min-w-0">
                        <span className="truncate">{p.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {scope === "agent" && (
              <Field>
                <FieldLabel htmlFor="memory-agent">{t("dialog.agent")}</FieldLabel>
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="memory-agent" className="w-full">
                    <SelectValue placeholder={t("dialog.chooseAgent")} />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-2rem)]">
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id} className="*:[span]:last:min-w-0">
                        <AgentAvatar avatar={a.avatar} size="xs" />
                        <span className="truncate">{a.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="memory-content">{t("dialog.content")}</FieldLabel>
              <Textarea
                id="memory-content"
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t("dialog.contentPlaceholder")}
                maxLength={MEMORY_MAX_LENGTH}
                required
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || !content.trim()}>
              {pending && <Spinner />} {tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

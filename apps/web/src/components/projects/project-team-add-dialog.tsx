"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { SparklesIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addProjectMembers, hireProjectMember } from "@/server/actions/projects";

type Candidate = { id: string; name: string; avatar: AgentAvatarValue; role: string };
type Template = { slug: string; name: string; avatar: AgentAvatarValue; role: string };
type Mode = "existing" | "hire";

/** A selectable row: the whole row is the label of its checkbox or radio. */
const ROW =
  "flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5 dark:bg-input/20 dark:has-data-[state=checked]:bg-primary/10";

function Identity({ name, role, avatar }: { name: string; role: string; avatar: AgentAvatarValue }) {
  return (
    <>
      <AgentAvatar avatar={avatar} size="lg" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium" title={name}>
          {name}
        </span>
        {role && (
          <span className="truncate text-xs text-muted-foreground" title={role}>
            {role}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Grows the team in one dialog: pick agents that already exist (they bring the same profession to every
 * project) or hire a new one from a template. The primary button follows the tab.
 */
export function AddTeamMembersDialog({
  projectId,
  candidates,
  templates,
  primary,
}: {
  projectId: string;
  /** Agents that can join (enabled, not templates, not the super agent) and are not on the team yet. */
  candidates: Candidate[];
  templates: Template[];
  /** The tab's main action; secondary while the project still needs a manager. */
  primary: boolean;
}) {
  const t = useTranslations("team.add");
  const tc = useTranslations("common.actions");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(candidates.length ? "existing" : "hire");
  const [selected, setSelected] = useState<string[]>([]);
  const [templateSlug, setTemplateSlug] = useState("");
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const template = templates.find((tpl) => tpl.slug === templateSlug);

  function onOpenChange(next: boolean) {
    if (next) {
      setMode(candidates.length ? "existing" : "hire");
      setSelected([]);
      setTemplateSlug("");
      setName("");
    }
    setOpen(next);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      if (mode === "existing") {
        const res = await addProjectMembers({ projectId, agentIds: selected });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("added", { count: selected.length }));
      } else {
        if (!template) return;
        const res = await hireProjectMember({ projectId, templateSlug: template.slug, name: name.trim() || undefined });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("hired", { name: res.data.name }));
      }
      setOpen(false);
    });
  }

  const canSubmit = mode === "existing" ? selected.length > 0 : Boolean(template);
  const submitLabel =
    mode === "existing"
      ? selected.length
        ? t("addCount", { count: selected.length })
        : t("addNone")
      : template
        ? t("hireNamed", { name: template.name })
        : t("hireNone");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={primary ? "default" : "outline"} size="sm">
          <UserPlusIcon />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="w-full">
              <TabsTrigger value="existing">
                <UsersIcon />
                {t("existingTab")}
              </TabsTrigger>
              <TabsTrigger value="hire">
                <SparklesIcon />
                {t("hireTab")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="existing" className="pt-2">
              {candidates.length ? (
                <div
                  role="group"
                  aria-label={t("existingTab")}
                  className="-mx-1 flex max-h-[45vh] flex-col gap-2 overflow-y-auto px-1 py-0.5"
                >
                  {candidates.map((a) => {
                    const checked = selected.includes(a.id);
                    return (
                      <label key={a.id} className={ROW}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            setSelected((list) => (v === true ? [...list, a.id] : list.filter((id) => id !== a.id)))
                          }
                        />
                        <Identity name={a.name} role={a.role} avatar={a.avatar} />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  {t.rich("noCandidates", {
                    link: (chunks) => (
                      <button
                        type="button"
                        onClick={() => setMode("hire")}
                        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                      >
                        {chunks}
                      </button>
                    ),
                  })}
                </p>
              )}
            </TabsContent>

            <TabsContent value="hire" className="flex flex-col gap-4 pt-2">
              {templates.length ? (
                <>
                  <RadioGroup
                    value={templateSlug}
                    onValueChange={setTemplateSlug}
                    aria-label={t("hireTab")}
                    className="-mx-1 flex max-h-[38vh] flex-col gap-2 overflow-y-auto px-1 py-0.5"
                  >
                    {templates.map((tpl) => (
                      <label key={tpl.slug} className={ROW}>
                        <RadioGroupItem value={tpl.slug} />
                        <Identity name={tpl.name} role={tpl.role} avatar={tpl.avatar} />
                      </label>
                    ))}
                  </RadioGroup>
                  {template && (
                    <Field>
                      <FieldLabel htmlFor="hire-name">{t("nameLabel")}</FieldLabel>
                      <Input
                        id="hire-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={template.name}
                        maxLength={80}
                        autoComplete="off"
                      />
                      <FieldDescription>{t("nameHint")}</FieldDescription>
                    </Field>
                  )}
                </>
              ) : (
                <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  {t("noTemplates")}
                </p>
              )}
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending || !canSubmit}>
              {pending ? <Spinner /> : mode === "existing" ? <UserPlusIcon /> : <SparklesIcon />}
              <span className="truncate">{submitLabel}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

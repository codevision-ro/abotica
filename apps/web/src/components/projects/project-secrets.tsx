"use client";

import { KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { SectionCard, SectionEmpty, SectionList, SectionRow } from "@/components/app/section-card";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useFormat } from "@/hooks/use-format";
import { deleteProjectSecret, setProjectSecret } from "@/server/actions/projects";
import type { ProjectSecret } from "@/server/queries/projects";

function secretPrefix(slug: string) {
  return `${slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_`;
}

export function ProjectSecrets({
  projectId,
  projectSlug,
  secrets,
}: {
  projectId: string;
  projectSlug: string;
  secrets: ProjectSecret[];
}) {
  const t = useTranslations("projects.secrets");
  const prefix = secretPrefix(projectSlug);
  const code = (chunks: React.ReactNode) => (
    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground wrap-anywhere">{chunks}</code>
  );
  return (
    <SectionCard
      icon={KeyRoundIcon}
      title={t("title")}
      count={secrets.length}
      description={t.rich("intro", { example: `{{secret:${t("nameExample")}}}`, code })}
      action={<SecretDialog projectId={projectId} prefix={prefix} />}
      flush
    >
      {secrets.length ? (
        <SectionList>
          {secrets.map((s) => (
            <SecretRow key={s.id} projectId={projectId} prefix={prefix} secret={s} />
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t.rich("empty", { example: `${prefix}API_KEY`, code })}</SectionEmpty>
      )}
    </SectionCard>
  );
}

function SecretRow({ projectId, prefix, secret }: { projectId: string; prefix: string; secret: ProjectSecret }) {
  const t = useTranslations("projects.secrets");
  const tc = useTranslations("common");
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const res = await deleteProjectSecret({ id: secret.id, projectId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("deleted"));
    });
  }

  return (
    <SectionRow
      media={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <KeyRoundIcon className="size-4" aria-hidden />
        </span>
      }
      title={
        <span className="font-mono" title={secret.name}>
          {secret.name}
        </span>
      }
      subtitle={
        <>
          {secret.description && <span title={secret.description}>{secret.description} · </span>}
          <span className="font-mono tracking-widest">••••</span> ·{" "}
          {t("updatedAt", { date: fmt.dateTime(secret.updatedAt) })}
        </>
      }
      trailing={
        <div className="flex items-center gap-1">
          <SecretDialog projectId={projectId} prefix={prefix} existing={secret} />
          <ConfirmDialog
            trigger={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tc("actions.delete")}
                title={tc("actions.delete")}
                className="text-muted-foreground hover:text-destructive"
                disabled={pending}
              >
                {pending ? <Spinner /> : <Trash2Icon />}
              </Button>
            }
            title={tc("confirmDelete.title", { name: secret.name })}
            description={t("deleteDescription", { reference: `{{secret:${secret.name}}}` })}
            titleClassName="break-all"
            descriptionClassName="break-words"
            confirm={tc("actions.delete")}
            destructive
            onConfirm={remove}
          />
        </div>
      }
    />
  );
}

function SecretDialog({ projectId, prefix, existing }: { projectId: string; prefix: string; existing?: ProjectSecret }) {
  const t = useTranslations("projects.secrets");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? prefix);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v) {
      setName(existing?.name ?? prefix);
      setValue("");
      setDescription(existing?.description ?? "");
      setError(null);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await setProjectSecret({ projectId, name, value, description });
      if (!res.ok) return setError(res.error);
      toast.success(existing ? t("updated") : t("saved"));
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {existing ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("editLabel", { name: existing.name })}
            title={t("editLabel", { name: existing.name })}
          >
            <PencilIcon />
          </Button>
        ) : (
          <Button>
            <PlusIcon />
            {t("add")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          // New secret: caret after the prefilled prefix, so typing completes the name instead of prepending.
          // Existing secret: the name is locked, start in the value field.
          e.preventDefault();
          const input = document.getElementById(existing ? "secret-value" : "secret-name") as HTMLInputElement | null;
          input?.focus();
          input?.setSelectionRange(input.value.length, input.value.length);
        }}
      >
        <DialogHeader>
          <DialogTitle className="break-all">
            {existing ? t("editTitle", { name: existing.name }) : t("newTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="secret-name">{t("nameLabel")}</FieldLabel>
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                disabled={!!existing}
                className="font-mono"
                required
              />
              <FieldDescription>
                {t.rich("nameHint", { prefix, code: (chunks) => <code className="text-xs break-all">{chunks}</code> })}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-value">{t("valueLabel")}</FieldLabel>
              <Input
                id="secret-value"
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={existing ? t("valueKeepPlaceholder") : ""}
                required={!existing}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-description">{t("descriptionLabel")}</FieldLabel>
              <Input
                id="secret-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {tc("actions.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {tc("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

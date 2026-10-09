"use client";

import type { ProjectRepo, RepoProvider } from "@abotica/core";
import {
  defaultRepoName,
  parseRepoUrl,
  providerOfHost,
  REPO_PROVIDERS,
  repoProtectionUrl,
  repoTokenUrl,
  repoWebUrl,
} from "@abotica/core/repo-url";
import { ExternalLinkIcon, FolderGitIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { ToneBadge } from "@/components/app/status-badge";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { addProjectRepo, deleteProjectRepo, recheckProjectRepo } from "@/server/actions/repos";

export function ProjectRepos({ projectId, repos }: { projectId: string; repos: ProjectRepo[] }) {
  const t = useTranslations("repos");
  return (
    <SectionCard
      icon={FolderGitIcon}
      title={t("title")}
      count={repos.length}
      description={t("intro")}
      action={<AddRepoDialog projectId={projectId} />}
      flush
    >
      {repos.length ? (
        <SectionList>
          {repos.map((repo) => (
            <RepoRow key={repo.id} repo={repo} />
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}

function ProtectionBadge({ repo }: { repo: ProjectRepo }) {
  const t = useTranslations("repos");
  const values = { branch: repo.defaultBranch, provider: t(`providers.${repo.provider}`) };
  if (repo.defaultBranchProtected === true) {
    return (
      <ToneBadge tone="success" title={t("protection.protectedHint", values)}>
        {t("protection.protected", values)}
      </ToneBadge>
    );
  }
  if (repo.defaultBranchProtected === null) {
    return (
      <ToneBadge tone="muted" title={t("protection.unknownHint", values)}>
        {t("protection.unknown")}
      </ToneBadge>
    );
  }
  // Unprotected: the badge leads to the provider's page where the branch gets protected.
  return (
    <a
      href={repoProtectionUrl(repo.provider, repo)}
      target="_blank"
      rel="noreferrer"
      aria-label={t("protection.fix", values)}
      title={`${t("protection.unprotectedHint", values)} ${t("protection.fix", values)}.`}
      className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ToneBadge tone="warning">
        {t("protection.unprotected", values)}
        <ExternalLinkIcon className="size-3" aria-hidden />
      </ToneBadge>
    </a>
  );
}

function RepoRow({ repo }: { repo: ProjectRepo }) {
  const t = useTranslations("repos");
  const tc = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const webUrl = repoWebUrl(repo);

  function recheck() {
    startTransition(async () => {
      const res = await recheckProjectRepo({ id: repo.id, projectId: repo.projectId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("rechecked", { name: repo.name }));
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await deleteProjectRepo({ id: repo.id, projectId: repo.projectId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("delete.deleted", { name: repo.name }));
    });
  }

  return (
    <SectionRow
      media={<SectionIcon icon={FolderGitIcon} variant="muted" />}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono" title={`repos/${repo.name}`}>
            {repo.name}
          </span>
          <ProtectionBadge repo={repo} />
        </span>
      }
      subtitle={
        <>
          <a href={webUrl} target="_blank" rel="noreferrer" title={webUrl} className="hover:text-primary hover:underline">
            {`${repo.host}/${repo.path}`}
          </a>
          {" · "}
          {t(`providers.${repo.provider}`)} · {t("row.defaultBranch", { branch: repo.defaultBranch })} ·{" "}
          <span className="font-mono">{t("row.token", { hint: repo.tokenHint })}</span> · {t("row.checked")}{" "}
          <RelativeTime date={repo.checkedAt} />
        </>
      }
      trailing={
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("recheck")}
            title={t("recheck")}
            onClick={recheck}
            disabled={pending}
          >
            <RefreshCwIcon className={pending ? "animate-spin" : undefined} />
          </Button>
          <ReplaceTokenDialog repo={repo} disabled={pending} />
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
                <Trash2Icon />
              </Button>
            }
            title={tc("confirmDelete.title", { name: repo.name })}
            description={t("delete.description", { repo: `${repo.host}/${repo.path}` })}
            titleClassName="break-words"
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

/** What the token needs on each provider, with a link to create it. */
function TokenHelp({
  provider,
  location,
  name,
}: {
  provider: RepoProvider;
  location: { host: string; path: string };
  name: string;
}) {
  const t = useTranslations("repos.token");
  return (
    <FieldDescription>
      {t(provider === "github" ? "githubHint" : "gitlabHint")}{" "}
      <a
        href={repoTokenUrl(provider, location, `Abotica ${name}`)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
      >
        {t(provider === "github" ? "githubCreate" : "gitlabCreate")}
        <ExternalLinkIcon className="size-3" aria-hidden />
      </a>
      <br />
      {t(provider === "github" ? "githubTracking" : "gitlabTracking")}
      <br />
      {t("proxy")}
    </FieldDescription>
  );
}

function AddRepoDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("repos");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [chosenProvider, setChosenProvider] = useState<RepoProvider | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const location = parseRepoUrl(url);
  const knownProvider = location ? providerOfHost(location.host) : null;
  const provider = knownProvider ?? chosenProvider;
  const suggestedName = location ? defaultRepoName(location.path) : "";
  const folder = name.trim() || suggestedName;

  function reset() {
    setUrl("");
    setChosenProvider(null);
    setName("");
    setToken("");
    setError(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addProjectRepo({ projectId, url, token, provider, name: name.trim() || null });
      if (!res.ok) return setError(res.error);
      const repo = res.data;
      if (repo.defaultBranchProtected === false) {
        toast.warning(
          t("add.addedUnprotected", {
            name: repo.name,
            branch: repo.defaultBranch,
            provider: t(`providers.${repo.provider}`),
          }),
        );
      } else {
        toast.success(t("add.added", { name: repo.name }));
      }
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          {t("add.button")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        // An accidental click outside must not discard a pasted token.
        onInteractOutside={(e) => (url.trim() || token.trim()) && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="repo-url">{t("add.urlLabel")}</FieldLabel>
              <Input
                id="repo-url"
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("add.urlPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
              <FieldDescription>
                {location ? (
                  <span className="text-foreground">
                    {knownProvider ? `${t(`providers.${knownProvider}`)} · ` : ""}
                    <span className="font-mono">{`${location.host}/${location.path}`}</span>
                  </span>
                ) : (
                  t("add.urlHint")
                )}
              </FieldDescription>
            </Field>

            {location && !knownProvider && (
              <Field>
                <FieldLabel htmlFor="repo-provider">{t("add.providerLabel")}</FieldLabel>
                <Select value={chosenProvider ?? ""} onValueChange={(v) => setChosenProvider(v as RepoProvider)}>
                  <SelectTrigger id="repo-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPO_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`providers.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{t("add.providerHint", { host: location.host })}</FieldDescription>
              </Field>
            )}

            {location && (
              <Field>
                <FieldLabel htmlFor="repo-name">{t("add.nameLabel")}</FieldLabel>
                <Input
                  id="repo-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  placeholder={suggestedName}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <FieldDescription>{t("add.nameHint", { name: folder })}</FieldDescription>
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="repo-token">{t("add.tokenLabel")}</FieldLabel>
              <Input
                id="repo-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              {location && provider && <TokenHelp provider={provider} location={location} name={folder} />}
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
            <Button type="submit" disabled={pending || !location || !provider || !token.trim()}>
              {pending && <Spinner />}
              {t("add.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceTokenDialog({ repo, disabled }: { repo: ProjectRepo; disabled: boolean }) {
  const t = useTranslations("repos");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await recheckProjectRepo({ id: repo.id, projectId: repo.projectId, token });
      if (!res.ok) return setError(res.error);
      toast.success(t("replaceToken.replaced", { name: repo.name }));
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setToken("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("replaceToken.button")}
          title={t("replaceToken.button")}
          disabled={disabled}
        >
          <KeyRoundIcon />
        </Button>
      </DialogTrigger>
      <DialogContent onInteractOutside={(e) => token.trim() && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="break-words">{t("replaceToken.title", { name: repo.name })}</DialogTitle>
          <DialogDescription>{t("replaceToken.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor={`repo-token-${repo.id}`}>{t("add.tokenLabel")}</FieldLabel>
            <Input
              id={`repo-token-${repo.id}`}
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <TokenHelp provider={repo.provider} location={repo} name={repo.name} />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {tc("actions.cancel")}
            </Button>
            <Button type="submit" disabled={pending || !token.trim()}>
              {pending && <Spinner />}
              {t("replaceToken.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

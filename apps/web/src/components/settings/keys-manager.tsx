"use client";

import { ArrowUpRight, Ellipsis, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionEmpty, SectionIcon, SectionList, sectionCardClass } from "@/components/app/section-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { deleteVaultSecret, setVaultSecret } from "@/server/actions/secrets";
import type { VaultSecretRow } from "@/server/queries/settings";
import { SecretInput } from "./secret-input";
import { SectionHeader } from "./section-header";

/** Where a key is used: the page that sets it up (Models, Telegram, the project). */
export type KeyUse = { label: string; href: string; title: string };

type KeyRow = VaultSecretRow & { use: KeyUse | null };

/** The list's filter: every key, the global ones, or one project's. */
export type KeysFilter = "all" | "global" | { projectId: string };

type Draft = {
  name: string;
  value: string;
  description: string;
  projectId: string | null;
  replacing: boolean;
};

const GLOBAL = "__global";
const ALL = "__all";
const NAME_RE = /^[A-Z0-9_]+$/;

/**
 * Settings > Keys: the keys and tokens in the vault, with where each is used, filtered by project;
 * values can be replaced, never read. `secrets` is the filtered list, `names` every key's name.
 */
export function KeysManager({
  title,
  description,
  secrets,
  names,
  projects,
  filter,
}: {
  title: string;
  description: string;
  secrets: KeyRow[];
  names: string[];
  projects: { id: string; name: string }[];
  filter: KeysFilter;
}) {
  const t = useTranslations("settings.keys");
  const tc = useTranslations("common.actions");
  const fmt = useFormat();
  const secretRef = `{{secret:${t("refName")}}}`;
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KeyRow | null>(null);
  const filterValue = filter === "all" ? ALL : filter === "global" ? GLOBAL : filter.projectId;
  const applyFilter = (value: string) =>
    router.replace(value === ALL ? pathname : `${pathname}?project=${value === GLOBAL ? "global" : value}`, {
      scroll: false,
    });
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();

  // The dialogs have no Radix trigger, so return focus by hand: to "Add key" or to the row's menu button.
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = (e: Event) => {
    if (!opener.current?.isConnected) return;
    e.preventDefault();
    opener.current.focus();
  };
  const rememberMenu = (e: React.SyntheticEvent<HTMLElement>) => {
    opener.current = e.currentTarget;
  };
  const openNew = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A new key belongs to the project the list shows.
    const projectId = typeof filter === "object" ? filter.projectId : null;
    setDraft({ name: "", value: "", description: "", projectId, replacing: false });
  };
  const openReplace = (s: KeyRow) =>
    setDraft({ name: s.name, value: "", description: s.description, projectId: s.projectId, replacing: true });

  const nameInvalid = Boolean(draft?.name) && !NAME_RE.test(draft!.name);
  const nameTaken = Boolean(draft && !draft.replacing && names.includes(draft.name));

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    startSave(async () => {
      const res = await setVaultSecret({
        name: draft.name,
        value: draft.value,
        description: draft.description,
        projectId: draft.projectId,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(draft.replacing || nameTaken ? t("replaced", { name: draft.name }) : t("added", { name: draft.name }));
      setDraft(null);
      router.refresh();
    });
  }

  function remove(id: string, name: string) {
    setRemovingId(id);
    startDelete(async () => {
      const res = await deleteVaultSecret({ id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted", { name }));
      router.refresh();
    });
  }

  /** Where a key is used, linked; "global" for one nothing in the app names. */
  const usageBadge = (s: KeyRow) =>
    s.use ? (
      <Badge asChild variant="outline" className="max-w-28 font-normal sm:max-w-40">
        <Link href={s.use.href} title={s.use.title}>
          <span className="truncate">{s.use.label}</span>
          <ArrowUpRight data-icon="inline-end" className="text-muted-foreground" aria-hidden />
        </Link>
      </Badge>
    ) : (
      <Badge variant="secondary" className="font-normal">
        {t("global")}
      </Badge>
    );

  return (
    <>
      <SectionHeader
        title={title}
        description={description}
        actions={
          <>
            {projects.length > 0 && (
              <Select value={filterValue} onValueChange={applyFilter}>
                <SelectTrigger aria-label={t("filter")} className="min-w-0 flex-1 sm:w-48 sm:flex-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectItem value={ALL}>{t("filterAll")}</SelectItem>
                  <SelectItem value={GLOBAL}>{t("filterGlobal")}</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button onClick={openNew}>
              <Plus /> {t("add")}
            </Button>
          </>
        }
      />
      <div className={cn(sectionCardClass, "overflow-hidden")}>
        {secrets.length === 0 ? (
          <SectionEmpty>
            {filter === "all"
              ? t.rich("empty", {
                  ref: secretRef,
                  mono: (chunks) => <span className="font-mono text-xs">{chunks}</span>,
                })
              : t("emptyFiltered")}
          </SectionEmpty>
        ) : (
          <SectionList>
            {secrets.map((s) => (
              <li
                key={s.id}
                className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 sm:px-5"
              >
                <SectionIcon icon={KeyRound} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm font-medium" title={s.name}>
                    {s.name}
                  </div>
                  {s.description && (
                    <div className="truncate text-xs text-muted-foreground" title={s.description}>
                      {s.description}
                    </div>
                  )}
                  {/* On a phone the badge goes under the name, which keeps the whole width. */}
                  <div className="mt-1.5 flex sm:hidden">{usageBadge(s)}</div>
                </div>
                <div className="hidden shrink-0 sm:flex">{usageBadge(s)}</div>
                <span aria-hidden className="hidden w-20 font-mono text-xs tracking-widest text-muted-foreground md:block">
                  ••••••••
                </span>
                <span
                  className="hidden w-24 truncate text-right text-xs text-muted-foreground sm:block"
                  title={fmt.dateTime(s.updatedAt)}
                >
                  <RelativeTime date={s.updatedAt} />
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("actionsAria", { name: s.name })}
                      onPointerDown={rememberMenu}
                      onKeyDown={rememberMenu}
                      disabled={deleting}
                    >
                      {deleting && removingId === s.id ? <Spinner /> : <Ellipsis />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={() => openReplace(s)}>
                      <RefreshCw /> {t("replace")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(s)}>
                      <Trash2 /> {tc("delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </SectionList>
        )}
      </div>

      <AlertDialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent onCloseAutoFocus={restoreFocus}>
          {confirmDelete && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="[overflow-wrap:anywhere]">
                  {t("deleteTitle", { name: confirmDelete.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove(confirmDelete.id, confirmDelete.name)}>
                  {tc("delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent onCloseAutoFocus={restoreFocus}>
          {draft && (
            <form onSubmit={save} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle className="[overflow-wrap:anywhere]">
                  {draft.replacing ? t("replaceTitle", { name: draft.name }) : t("newTitle")}
                </DialogTitle>
                <DialogDescription>{t("dialogDescription")}</DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field data-invalid={nameInvalid}>
                  <FieldLabel htmlFor="secret-name">{t("name")}</FieldLabel>
                  <Input
                    id="secret-name"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        name: e.target.value.toUpperCase().replace(/[\s-]/g, "_"),
                      })
                    }
                    placeholder="GITHUB_TOKEN"
                    className="font-mono"
                    disabled={draft.replacing}
                    aria-invalid={nameInvalid}
                    required
                  />
                  <FieldDescription>
                    {nameInvalid ? t("nameInvalid") : nameTaken ? t("nameTaken") : t("nameHint", { ref: secretRef })}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="secret-value">{t("value")}</FieldLabel>
                  <SecretInput
                    id="secret-value"
                    value={draft.value}
                    onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="secret-description">{t("descriptionLabel")}</FieldLabel>
                  <Input
                    id="secret-description"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder={t("descriptionPlaceholder")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="secret-project">{t("project")}</FieldLabel>
                  <Select
                    value={draft.projectId ?? GLOBAL}
                    onValueChange={(v) => setDraft({ ...draft, projectId: v === GLOBAL ? null : v })}
                  >
                    <SelectTrigger id="secret-project" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={GLOBAL}>{t("globalOption")}</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                  {tc("cancel")}
                </Button>
                <Button type="submit" disabled={saving || nameInvalid || !draft.name || !draft.value}>
                  {saving && <Spinner />} {tc("save")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

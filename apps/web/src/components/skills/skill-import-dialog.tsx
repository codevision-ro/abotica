"use client";

import type { FetchedSkill, SkillChoice } from "@abotica/core";
import { checkSkillFiles } from "@abotica/core/skill-md";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileArchiveIcon,
  FolderIcon,
  ImportIcon,
  LinkIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { fetchSkillPreview, importSkill, resolveSkillUrl } from "@/server/actions/skills";
import { SkillIcon } from "./skill-icon";
import { SkillPreview, skillSourceKey, useInstallSkill } from "./skill-preview";
import { type LocalSkill, readDroppedSkill, readPickedSkill } from "./skill-upload";

type Step =
  | { kind: "source" }
  | { kind: "choose"; url: string; choices: SkillChoice[] }
  | { kind: "local"; skill: LocalSkill }
  | { kind: "remote"; skill: FetchedSkill; choices?: { url: string; list: SkillChoice[] } };

/**
 * Adds a skill from the user's computer (zip, folder or SKILL.md) or from a link (GitHub, skills.sh).
 * Both end on the same preview, with one action: add the local folder or install the remote one.
 */
export function SkillImportDialog({ installed }: { installed: Record<string, string> }) {
  const t = useTranslations("skills.import");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "source" });
  // Bumped by every navigation and request, so a late answer cannot move the dialog after the user went back.
  const request = useRef(0);

  function go(next: Step) {
    request.current++;
    setStep(next);
  }

  /** Starts a request; the returned check tells whether it is still the latest. */
  function begin() {
    const id = ++request.current;
    return () => id === request.current;
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) go({ kind: "source" });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <ImportIcon /> {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex flex-col gap-0 p-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none sm:h-[min(90dvh,52rem)] sm:max-w-5xl">
        <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3.5 pr-12 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary dark:bg-primary/15">
            <ImportIcon className="size-5" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className="text-base leading-snug font-semibold tracking-tight">{t("title")}</DialogTitle>
            <DialogDescription className="text-pretty">{t("description")}</DialogDescription>
          </div>
        </DialogHeader>
        {step.kind === "source" && <SourceStep begin={begin} onStep={setStep} />}
        {step.kind === "choose" && (
          <ChooseStep step={step} begin={begin} onStep={setStep} onBack={() => go({ kind: "source" })} />
        )}
        {step.kind === "local" && <LocalStep skill={step.skill} onBack={() => go({ kind: "source" })} />}
        {step.kind === "remote" && (
          <RemoteStep
            skill={step.skill}
            installedId={installed[skillSourceKey(step.skill.source)]}
            onBack={() =>
              go(step.choices ? { kind: "choose", url: step.choices.url, choices: step.choices.list } : { kind: "source" })
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type StepProps = {
  begin: () => () => boolean;
  onStep: (step: Step) => void;
};

/** The two ways in: a drop zone for files on this computer and a field for a link. */
function SourceStep({ begin, onStep }: StepProps) {
  const t = useTranslations("skills.import");
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const busy = reading || resolving;

  async function readFiles(read: Promise<LocalSkill | null>) {
    const isCurrent = begin();
    setReading(true);
    setFileError(null);
    try {
      const skill = await read;
      if (!isCurrent()) return;
      if (skill) onStep({ kind: "local", skill });
      else setFileError(t("noSkillMd"));
    } catch {
      if (isCurrent()) setFileError(t("unreadable"));
    } finally {
      setReading(false);
    }
  }

  async function resolve(e: React.FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!value || busy) return;
    const isCurrent = begin();
    setResolving(true);
    setLinkError(null);
    const res = await resolveSkillUrl({ url: value });
    setResolving(false);
    if (!isCurrent()) return;
    if (!res.ok) return setLinkError(res.error);
    if (res.data.kind === "single") onStep({ kind: "remote", skill: res.data.skill });
    else onStep({ kind: "choose", url: value, choices: res.data.choices });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-6">
      <section aria-labelledby="skill-import-computer" className="flex min-h-64 flex-1 flex-col gap-2.5">
        <h3 id="skill-import-computer" className="text-sm font-medium">
          {t("computerTitle")}
        </h3>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) void readFiles(readDroppedSkill(e.dataTransfer));
          }}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border bg-muted/20",
          )}
        >
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary/8 text-primary dark:bg-primary/15">
            {reading ? <Spinner className="size-5" /> : <UploadIcon className="size-5" aria-hidden />}
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">{reading ? t("reading") : t("dropTitle")}</p>
            <p className="text-xs text-pretty text-muted-foreground">{t("dropHint")}</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              <FileArchiveIcon /> {t("chooseFile")}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => folderRef.current?.click()}>
              <FolderIcon /> {t("chooseFolder")}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.md,.markdown,application/zip,text/markdown"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void readFiles(readPickedSkill(e.target.files));
              e.target.value = "";
            }}
          />
          <input
            ref={folderRef}
            type="file"
            // @ts-expect-error webkitdirectory is not in React's input attributes, every browser supports it.
            webkitdirectory=""
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void readFiles(readPickedSkill(e.target.files));
              e.target.value = "";
            }}
          />
        </div>
        {fileError && (
          <p role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        )}
      </section>

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        {t("or")}
        <span className="h-px flex-1 bg-border" />
      </div>

      <section aria-labelledby="skill-import-link" className="flex flex-col gap-2.5">
        <h3 id="skill-import-link" className="text-sm font-medium">
          {t("linkTitle")}
        </h3>
        <form onSubmit={resolve} className="flex flex-col gap-1.5">
          <InputGroup>
            <InputGroupAddon>
              <LinkIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("linkPlaceholder")}
              aria-label={t("linkTitle")}
              aria-invalid={!!linkError}
              aria-describedby="skill-import-link-hint"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit" variant="default" size="sm" disabled={!url.trim() || busy}>
                {resolving ? <Spinner /> : <ArrowRightIcon />} {t("load")}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {linkError ? (
            <p id="skill-import-link-hint" role="alert" className="text-sm text-destructive">
              {linkError}
            </p>
          ) : (
            <p id="skill-import-link-hint" className="text-xs text-muted-foreground">
              {t("linkHint")}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}

/** A link with several skills (a repo of skills): pick the one to preview. */
function ChooseStep({
  step,
  begin,
  onStep,
  onBack,
}: StepProps & { step: Extract<Step, { kind: "choose" }>; onBack: () => void }) {
  const t = useTranslations("skills.import");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const visible = step.choices
    .map((choice, index) => ({ choice, index }))
    .filter(({ choice }) => !q || `${choice.name} ${choice.description}`.toLowerCase().includes(q));

  async function pick(choice: SkillChoice, index: number) {
    const isCurrent = begin();
    setLoading(index);
    setError(null);
    const res = await fetchSkillPreview({ ref: choice.ref });
    if (!isCurrent()) return;
    setLoading(null);
    if (!res.ok) return setError(res.error);
    onStep({ kind: "remote", skill: res.data, choices: { url: step.url, list: step.choices } });
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          {t.rich("found", {
            count: step.choices.length,
            source: step.url,
            mono: (chunks) => <span className="font-mono text-foreground">{chunks}</span>,
          })}
        </p>
        {step.choices.length > 6 && (
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("filter")}
              aria-label={t("filter")}
            />
          </InputGroup>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMatch")}</p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto rounded-xl border bg-card dark:bg-input/20">
            {visible.map(({ choice, index }) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => void pick(choice, index)}
                  disabled={loading !== null}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:cursor-default"
                >
                  <SkillIcon size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{choice.name}</span>
                    <span
                      className={cn(
                        "line-clamp-2 text-xs text-muted-foreground",
                        !choice.description && "text-muted-foreground/60",
                      )}
                    >
                      {choice.description || t("noDescription")}
                    </span>
                  </span>
                  {loading === index ? (
                    <Spinner className="text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <StepFooter onBack={onBack} />
    </>
  );
}

/** Files from this computer: checked here, added as a new skill. */
function LocalStep({ skill, onBack }: { skill: LocalSkill; onBack: () => void }) {
  const t = useTranslations("skills.import");
  const tf = useTranslations("skills.files");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { pkg } = skill;
  const problem = checkSkillFiles(pkg.files);
  const blocked = problem ? tf(problem.code, problem) : pkg.name ? null : t("noName");

  function add() {
    startTransition(async () => {
      const res = await importSkill({
        name: pkg.name,
        description: pkg.description,
        metadata: pkg.metadata,
        files: pkg.files,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("added", { name: pkg.name }));
      router.push(`/skills/${res.data.id}`);
    });
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <SkillPreview pkg={pkg} skipped={skill.skipped} source={{ kind: "local", label: skill.label }} />
      </div>
      <StepFooter
        onBack={onBack}
        disabled={pending}
        reason={blocked && <span className="text-destructive">{blocked}</span>}
      >
        <Button onClick={add} disabled={!!blocked || pending}>
          {pending ? <Spinner /> : <PlusIcon />} {t("add")}
        </Button>
      </StepFooter>
    </>
  );
}

/** A skill from GitHub or skills.sh: installed pinned to the previewed files, or opened if already there. */
function RemoteStep({ skill, installedId, onBack }: { skill: FetchedSkill; installedId?: string; onBack: () => void }) {
  const tp = useTranslations("skills.preview");
  const { install, pending } = useInstallSkill();
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <SkillPreview
          key={skill.source.hash}
          pkg={skill.pkg}
          skipped={skill.skipped}
          source={{ kind: "remote", origin: skill.source }}
        />
      </div>
      <StepFooter onBack={onBack} disabled={pending} reason={installedId ? tp("alreadyInstalled") : null}>
        {installedId ? (
          <Button asChild>
            <Link href={`/skills/${installedId}`}>
              {tp("openInstalled")} <ArrowRightIcon />
            </Link>
          </Button>
        ) : (
          <Button onClick={() => install(skill)} disabled={pending}>
            {pending ? <Spinner /> : <DownloadIcon />} {tp("install")}
          </Button>
        )}
      </StepFooter>
    </>
  );
}

/** Back on the left; the step's single primary action on the right, with the reason when it is unavailable. */
function StepFooter({
  onBack,
  disabled,
  reason,
  children,
}: {
  onBack: () => void;
  disabled?: boolean;
  /** Why the action is unavailable, or a short status next to it. */
  reason?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const tc = useTranslations("common.actions");
  return (
    <DialogFooter className="m-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 rounded-none px-4 py-3 sm:justify-between sm:rounded-b-xl sm:px-6">
      <Button variant="ghost" onClick={onBack} disabled={disabled}>
        <ArrowLeftIcon /> {tc("back")}
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        {reason && <p className="min-w-0 text-right text-xs text-pretty text-muted-foreground">{reason}</p>}
        {children}
      </div>
    </DialogFooter>
  );
}

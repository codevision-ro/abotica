"use client";

import { checkSkillFiles, SKILL_MD, type SkillFileEntry, type SkillFilesProblem } from "@abotica/core/skill-md";
import { slugify } from "@abotica/core/slug";
import type { SkillSource } from "@abotica/db";
import {
  DownloadIcon,
  FilesIcon,
  FlaskConicalIcon,
  PlusIcon,
  SaveIcon,
  TriangleAlertIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { DangerZoneCard } from "@/components/app/danger-zone-card";
import { FormPage } from "@/components/app/form-page";
import { FormSection, FormSectionCollapsible } from "@/components/app/form-section";
import { heroFieldVariants } from "@/components/app/hero-fields";
import { SummaryItem, SummaryList, type SummaryStatus } from "@/components/app/summary-rail";
import { AssignmentChips } from "@/components/mcp/assignment-chips";
import { SkillTestPanel } from "@/components/skills/skill-test-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { createSkill, deleteSkill, updateSkill } from "@/server/actions/skills";
import type { PickerOption } from "./assignment-picker";
import { downloadSkillZip } from "./skill-export";
import { SkillFilesEditor } from "./skill-files-editor";
import { SkillIcon } from "./skill-icon";
import { SkillSourceBanner } from "./skill-source-banner";

export type SkillFormInitial = {
  name: string;
  slug: string;
  description: string;
  /** Frontmatter fields besides name and description; kept as they are. */
  metadata: Record<string, unknown>;
  files: SkillFileEntry[];
  enabled: boolean;
  agentIds: string[];
  projectIds: string[];
};

type Mode = { kind: "create" } | { kind: "edit"; skillId: string; source: SkillSource | null; modified: boolean };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Section ids: scroll targets of the summary rail. */
const SECTIONS = {
  identity: "skill-identity",
  files: "skill-files",
  assignment: "skill-assignment",
  test: "skill-test",
} as const;

/** Everything but the files, as JSON; undefined drops the files key. */
const fieldsJson = (value: SkillFormInitial) => JSON.stringify({ ...value, files: undefined });

/** What the dirty check compares against: the fields as JSON, the files by path. */
function savedState(value: SkillFormInitial) {
  return { fields: fieldsJson(value), files: new Map(value.files.map((f) => [f.path, f.content])) };
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

export function SkillForm({
  mode,
  initial,
  agents,
  projects,
}: {
  mode: Mode;
  initial: SkillFormInitial;
  agents: PickerOption[];
  projects: PickerOption[];
}) {
  const t = useTranslations("skills.form");
  const tf = useTranslations("skills.files");
  const tl = useTranslations("skills.list");
  const tc = useTranslations("common.actions");
  const format = useFormat();
  const router = useRouter();
  const [v, setValues] = useState(initial);
  const [selected, setSelected] = useState(SKILL_MD);
  const [slugTouched, setSlugTouched] = useState(mode.kind === "edit");
  const [testOpen, setTestOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [saved, setSaved] = useState(() => savedState(initial));

  const set = <K extends keyof SkillFormInitial>(key: K, value: SkillFormInitial[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const unsaved = useMemo(
    () => new Set(v.files.filter((f) => saved.files.get(f.path) !== f.content).map((f) => f.path)),
    [v.files, saved],
  );
  const dirty = fieldsJson(v) !== saved.fields || unsaved.size > 0 || v.files.length !== saved.files.size;

  // Whole-folder checks scan every file, so they trail the keystrokes.
  const deferredFiles = useDeferredValue(v.files);
  const problem = useMemo(() => checkSkillFiles(deferredFiles), [deferredFiles]);
  const totalBytes = useMemo(() => deferredFiles.reduce((sum, f) => sum + byteLength(f.content), 0), [deferredFiles]);

  const editing = mode.kind === "edit";
  const slugError = v.slug && !SLUG_RE.test(v.slug) ? t("slugInvalid") : null;
  const problemMessage = (p: SkillFilesProblem) => {
    const { code, ...values } = p;
    return tf(code, values as Record<string, string | number>);
  };
  const pkg = () => ({ name: v.name.trim(), description: v.description.trim(), metadata: v.metadata, files: v.files });

  function onNameChange(name: string) {
    setValues((prev) => ({ ...prev, name, slug: slugTouched ? prev.slug : slugify(name) }));
  }

  function submit() {
    const issue = checkSkillFiles(v.files);
    if (issue) {
      if ("path" in issue && v.files.some((f) => f.path === issue.path)) setSelected(issue.path);
      return void toast.error(problemMessage(issue));
    }
    const payload = { ...pkg(), slug: v.slug, enabled: v.enabled, agentIds: v.agentIds, projectIds: v.projectIds };
    startTransition(async () => {
      if (mode.kind === "create") {
        const res = await createSkill(payload);
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("created"));
        setSaved(savedState(v));
        router.push(`/skills/${res.data.id}`);
      } else {
        const res = await updateSkill({ ...payload, id: mode.skillId, note });
        if (!res.ok) return void toast.error(res.error);
        setNote("");
        toast.success(res.data.changed.length ? t("savedVersion", { version: res.data.version }) : t("saved"));
        setSaved(savedState(v));
        router.refresh();
      }
    });
  }

  function remove() {
    if (mode.kind !== "edit") return;
    startDelete(async () => {
      const res = await deleteSkill({ id: mode.skillId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      router.push("/skills");
    });
  }

  const link = (href: string) =>
    function RichLink(chunks: React.ReactNode) {
      return (
        <Link href={href} className="underline underline-offset-2">
          {chunks}
        </Link>
      );
    };

  const submitButton = (className?: string) => (
    <Button type="submit" disabled={pending || Boolean(slugError)} className={className}>
      {pending ? <Spinner /> : editing ? <SaveIcon /> : <PlusIcon />}
      {editing ? tc("save") : t("create")}
    </Button>
  );
  const cancelLink = !editing && (
    <Button type="button" variant="ghost" asChild>
      <Link href="/skills">{tc("cancel")}</Link>
    </Button>
  );

  const status = (done: boolean): SummaryStatus => (done ? "done" : "todo");
  const statusLabel = (done: boolean) => (done ? t("complete") : t("incomplete"));
  const name = v.name.trim();
  const identityDone = Boolean(name && v.slug && !slugError);
  const skillMdEmpty = !v.files.find((f) => f.path === SKILL_MD)?.content.trim();
  const filesDone = !problem && !skillMdEmpty;
  const filesSummary = problem
    ? problemMessage(problem)
    : skillMdEmpty
      ? t("instructionsMissing")
      : t("filesSummary", { count: v.files.length, size: format.fileSize(totalBytes) });
  const assignmentSummary = `${tl("agents", { count: v.agentIds.length })} · ${tl("projects", { count: v.projectIds.length })}`;

  return (
    <FormPage
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      guard={dirty && !pending && !deleting}
      identity={{
        name,
        untitled: t("untitled"),
        subtitle: v.slug,
        subtitleClassName: "font-mono",
        media: (size) => <SkillIcon size={size} />,
      }}
      // In edit mode the page header already shows which skill this is.
      identityInRail={!editing}
      summary={
        <SummaryList label={t("summaryLabel")}>
          <SummaryItem
            target={SECTIONS.identity}
            status={status(identityDone)}
            statusLabel={statusLabel(identityDone)}
            label={t("identityTitle")}
          >
            {!name ? t("nameMissing") : (slugError ?? null)}
          </SummaryItem>
          <SummaryItem
            target={SECTIONS.files}
            status={status(filesDone)}
            statusLabel={statusLabel(filesDone)}
            label={t("filesTitle")}
          >
            <span className={cn(problem && "text-destructive")} title={filesSummary}>
              {filesSummary}
            </span>
          </SummaryItem>
          <SummaryItem target={SECTIONS.assignment} status="info" label={t("assignmentTitle")}>
            {assignmentSummary}
          </SummaryItem>
          <SummaryItem target={SECTIONS.assignment} status="info" label={t("statusTitle")}>
            {v.enabled ? t("active") : t("inactive")}
          </SummaryItem>
        </SummaryList>
      }
      versionNote={
        editing ? { value: note, onChange: setNote, placeholder: t("versionNote"), label: t("versionNoteAria") } : undefined
      }
      submit={submitButton}
      cancel={cancelLink}
      status={editing ? (dirty ? t("unsaved") : t("noChanges")) : undefined}
    >
      <section
        id={SECTIONS.identity}
        aria-label={t("identityTitle")}
        className={cn("mb-2 flex scroll-mt-20 items-center", editing ? "gap-4" : "gap-4 sm:gap-5")}
      >
        {/* Smaller in edit mode, where the page header already names the skill. */}
        <SkillIcon
          size={editing ? "xl" : "2xl"}
          className={cn(!editing && "sm:size-20 sm:rounded-[1.25rem] sm:[&_svg]:size-10")}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor="skill-name" className="sr-only">
            {t("name")}
          </label>
          <input
            id="skill-name"
            value={v.name}
            onChange={(e) => onNameChange(e.target.value)}
            required
            maxLength={120}
            autoComplete="off"
            // A new skill starts with the name: the rest has a template or can wait.
            autoFocus={!editing}
            placeholder={t("namePlaceholder")}
            className={cn(heroFieldVariants({ kind: "title" }), editing ? "text-lg" : "text-2xl sm:text-3xl")}
          />
          <label htmlFor="skill-description" className="sr-only">
            {t("description")}
          </label>
          <textarea
            id="skill-description"
            value={v.description}
            onChange={(e) => set("description", e.target.value)}
            rows={1}
            maxLength={1024}
            placeholder={t("descriptionPlaceholder")}
            className={cn(
              heroFieldVariants({ kind: "subtitle" }),
              "field-sizing-content resize-none",
              // Installed skills often bring long descriptions; they scroll instead of pushing the form down.
              editing ? "max-h-[4.5lh] overflow-y-auto py-0.5 text-sm" : "py-1 text-base",
            )}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
            <label htmlFor="skill-slug" className="sr-only">
              {t("slug")}
            </label>
            <input
              id="skill-slug"
              value={v.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set("slug", e.target.value.toLowerCase());
              }}
              size={Math.max(v.slug.length || t("slugPlaceholder").length, 6)}
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("slugPlaceholder")}
              aria-invalid={Boolean(slugError)}
              aria-describedby="skill-slug-hint"
              className="-ml-2 max-w-full min-w-0 rounded-lg bg-transparent px-2 py-1 font-mono text-sm text-muted-foreground transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:text-foreground aria-invalid:text-destructive"
            />
            <span
              id="skill-slug-hint"
              className={cn("text-xs", slugError ? "text-destructive" : "text-muted-foreground/80")}
            >
              {slugError ?? t("slugHint")}
            </span>
          </div>
        </div>
      </section>

      {mode.kind === "edit" && mode.source && (
        <SkillSourceBanner skillId={mode.skillId} source={mode.source} modified={mode.modified} dirty={dirty} />
      )}

      <FormSection
        id={SECTIONS.files}
        icon={FilesIcon}
        title={t("filesTitle")}
        description={t("filesDescription")}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => downloadSkillZip(pkg(), v.slug)}
            aria-label={t("exportAria")}
            title={t("exportAria")}
          >
            <DownloadIcon /> <span className="hidden sm:inline">{t("export")}</span>
          </Button>
        }
      >
        <SkillFilesEditor
          files={v.files}
          onFilesChange={(files) => set("files", files)}
          selected={selected}
          onSelect={setSelected}
          unsaved={unsaved}
          metadata={v.metadata}
        />
        {problem && (
          <p className="flex items-center gap-1.5 text-sm text-destructive" aria-live="polite">
            <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
            {problemMessage(problem)}
          </p>
        )}
      </FormSection>

      <FormSection
        id={SECTIONS.assignment}
        icon={UsersRoundIcon}
        title={t("assignmentTitle")}
        description={t("assignmentDescription")}
      >
        <AssignmentChips
          title={t("agents")}
          items={agents}
          selected={v.agentIds}
          onChange={(ids) => set("agentIds", ids)}
          empty={t.rich("noAgents", { link: link("/agents/new") })}
        />
        <AssignmentChips
          title={t("projects")}
          items={projects}
          selected={v.projectIds}
          onChange={(ids) => set("projectIds", ids)}
          empty={t.rich("noProjects", { link: link("/projects/new") })}
        />
        <label
          htmlFor="skill-enabled"
          className="flex cursor-pointer items-center gap-3 rounded-xl border bg-background/60 p-3 dark:bg-input/10"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{t("active")}</span>
            <span className="text-xs text-muted-foreground">{t("activeHint")}</span>
          </span>
          <Switch id="skill-enabled" checked={v.enabled} onCheckedChange={(on) => set("enabled", on)} />
        </label>
      </FormSection>

      <FormSectionCollapsible
        id={SECTIONS.test}
        icon={FlaskConicalIcon}
        title={t("testTitle")}
        summary={t("testSummary")}
        open={testOpen}
        onOpenChange={setTestOpen}
      >
        <SkillTestPanel
          skillId={mode.kind === "edit" ? mode.skillId : undefined}
          slug={v.slug}
          name={v.name}
          description={v.description}
          skillMd={v.files.find((f) => f.path === SKILL_MD)?.content ?? ""}
          filePaths={v.files.map((f) => f.path)}
          agents={agents}
          dirty={dirty}
        />
      </FormSectionCollapsible>

      {mode.kind === "edit" && (
        <DangerZoneCard
          id="skill"
          title={t("deleteCardTitle")}
          description={t("deleteCardDescription")}
          confirmTitle={t("deleteTitle", { name: initial.name })}
          confirmDescription={t("deleteDescription")}
          deleting={deleting}
          onDelete={remove}
        />
      )}
    </FormPage>
  );
}

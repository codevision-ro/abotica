"use client";

import {
  isTextContent,
  normalizeSkillPath,
  parseSkillMd,
  referencedSkillPaths,
  SKILL_MD,
  type SkillFileEntry,
} from "@abotica/core/skill-md";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES } from "@abotica/core/limits";
import { FilePlusIcon, PencilLineIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { createElement, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { ConfirmDelete } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { SkillFileTree, skillFileIcon } from "./skill-file-tree";

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** "references/api.md" -> "references/"; "" for files at the top of the skill. */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Frontmatter values as they would read in YAML, on one line. */
function metadataLine(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : JSON.stringify(value);
      return `${key}: ${text}`;
    })
    .join(" · ");
}

/**
 * The files of a skill, IDE-like: the tree on the left (a file switcher above the editor on phones),
 * the selected file on the right with Edit/Preview for markdown. Changes stay local until the form saves.
 */
export function SkillFilesEditor({
  files,
  onFilesChange,
  selected,
  onSelect,
  unsaved,
  metadata,
}: {
  files: SkillFileEntry[];
  onFilesChange: (files: SkillFileEntry[]) => void;
  selected: string;
  onSelect: (path: string) => void;
  /** Paths whose content differs from the saved skill. */
  unsaved: Set<string>;
  /** Frontmatter fields besides name and description, shown read-only on SKILL.md. */
  metadata: Record<string, unknown>;
}) {
  const t = useTranslations("skills.editor");
  const format = useFormat();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const uploadRef = useRef<HTMLInputElement>(null);

  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const file = files.find((f) => f.path === selected) ?? files[0];
  const content = file?.content ?? "";
  const path = file?.path ?? SKILL_MD;
  const markdown = isMarkdown(path);
  const folder = folderOf(path);

  const deferredContent = useDeferredValue(content);
  const missing = useMemo(
    () => (markdown ? referencedSkillPaths(deferredContent, path).filter((p) => !paths.includes(p)) : []),
    [markdown, deferredContent, path, paths],
  );
  const unsavedDot = (className?: string) => (
    <span role="img" aria-label={t("unsavedFile")} className={cn("size-1.5 rounded-full bg-primary", className)} />
  );
  const marks = Object.fromEntries([...unsaved].map((p) => [p, unsavedDot("block")]));
  const extras = path === SKILL_MD && Object.keys(metadata).length ? metadataLine(metadata) : "";

  const setContent = (next: string) => onFilesChange(files.map((f) => (f.path === path ? { ...f, content: next } : f)));

  function addFile(newPath: string) {
    onFilesChange([...files, { path: newPath, content: "" }]);
    onSelect(newPath);
  }

  function renameFile(newPath: string) {
    onFilesChange(files.map((f) => (f.path === path ? { ...f, path: newPath } : f)));
    onSelect(newPath);
  }

  function deleteFile() {
    onFilesChange(files.filter((f) => f.path !== path));
    onSelect(SKILL_MD);
  }

  /** Adds the chosen files to the selected file's folder; a file with the same path is replaced. */
  async function upload(list: FileList) {
    const next = [...files];
    const skipped: string[] = [];
    let last: string | null = null;
    for (const picked of Array.from(list)) {
      const target = normalizeSkillPath(folder + picked.name);
      const text = picked.size <= SKILL_MAX_FILE_BYTES ? (await picked.text()).replace(/\r\n?/g, "\n") : null;
      if (!target || text === null || !isTextContent(text)) {
        skipped.push(picked.name);
        continue;
      }
      // An uploaded SKILL.md keeps its frontmatter out: name and description live in the fields above.
      const entry = { path: target, content: target === SKILL_MD ? parseSkillMd(text).body : text };
      const index = next.findIndex((f) => f.path === target);
      if (index >= 0) next[index] = entry;
      else if (next.length < SKILL_MAX_FILES) next.push(entry);
      else {
        skipped.push(picked.name);
        continue;
      }
      last = target;
    }
    if (last) {
      onFilesChange(next);
      onSelect(last);
      toast.success(t("uploaded", { count: list.length - skipped.length }));
    }
    if (skipped.length) toast.error(t("uploadSkipped", { names: skipped.join(", ") }));
  }

  const uploadLabel = folder ? t("uploadInto", { folder }) : t("upload");

  return (
    // A container: the two panes need room the page layout does not tell (the summary rail takes some).
    <div className="@container">
      <div className="grid overflow-hidden rounded-xl border bg-card shadow-xs transition-[color,box-shadow] has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/50 @lg:grid-cols-[12rem_minmax(0,1fr)] dark:bg-input/20">
        <div className="flex min-w-0 flex-col border-b bg-muted/30 @lg:border-r @lg:border-b-0 dark:bg-muted/10">
          <div className="flex h-11 shrink-0 items-center gap-1 px-2 @lg:border-b">
            <span className="hidden flex-1 px-1.5 text-xs font-medium text-muted-foreground @lg:block">
              {t("filesLabel")}
              <span className="tabular ml-1.5 font-normal">{files.length}</span>
            </span>
            {/* Phones: a file switcher instead of the tree. */}
            <Select value={path} onValueChange={onSelect}>
              <SelectTrigger
                size="sm"
                aria-label={t("switcherLabel")}
                className="min-w-0 flex-1 font-mono text-xs @lg:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paths.map((p) => (
                  <SelectItem key={p} value={p} className="font-mono text-xs">
                    {p}
                    {unsaved.has(p) && unsavedDot("ml-1.5 inline-block align-middle")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <PathPopover
              label={t("newFile")}
              submitLabel={t("create")}
              paths={paths}
              initial={folder}
              onSubmit={addFile}
              trigger={
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("newFile")} title={t("newFile")}>
                  <FilePlusIcon />
                </Button>
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={uploadLabel}
              title={uploadLabel}
              onClick={() => uploadRef.current?.click()}
            >
              <UploadIcon />
            </Button>
            <input
              ref={uploadRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="relative hidden min-h-0 flex-1 @lg:block">
            <div className="absolute inset-0 overflow-y-auto p-1.5">
              <SkillFileTree paths={paths} selected={path} onSelect={onSelect} marks={marks} label={t("treeLabel")} />
            </div>
          </div>
        </div>

        <Tabs
          value={markdown ? mode : "edit"}
          onValueChange={(value) => setMode(value as typeof mode)}
          className="min-w-0 gap-0"
        >
          <div className="flex h-11 items-center gap-2 border-b px-2 sm:px-3">
            <span className="hidden min-w-0 flex-1 items-center gap-1.5 text-sm @lg:flex">
              {createElement(skillFileIcon(path), {
                className: "size-4 shrink-0 text-muted-foreground",
                "aria-hidden": true,
              })}
              <span className="truncate font-mono text-[13px]" title={path}>
                {path}
              </span>
            </span>
            {markdown && (
              <TabsList className="h-7">
                <TabsTrigger value="edit" className="px-2.5 text-xs">
                  {t("edit")}
                </TabsTrigger>
                <TabsTrigger value="preview" className="px-2.5 text-xs">
                  {t("preview")}
                </TabsTrigger>
              </TabsList>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {path !== SKILL_MD && (
                <>
                  <PathPopover
                    label={t("rename")}
                    submitLabel={t("renameSubmit")}
                    paths={paths}
                    initial={path}
                    current={path}
                    onSubmit={renameFile}
                    trigger={
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("rename")} title={t("rename")}>
                        <PencilLineIcon />
                      </Button>
                    }
                  />
                  <ConfirmDelete
                    label={t("deleteFile")}
                    title={t("deleteTitle", { path })}
                    description={t("deleteDescription")}
                    onConfirm={async () => deleteFile()}
                  />
                </>
              )}
            </div>
          </div>

          {extras && (
            <p className="truncate border-b bg-muted/20 px-4 py-1.5 font-mono text-xs text-muted-foreground" title={extras}>
              <span className="sr-only">{t("frontmatter")}: </span>
              {extras}
            </p>
          )}
          <TabsContent value="edit">
            <Textarea
              key={path}
              aria-label={t("contentAria", { path })}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={path === SKILL_MD ? t("skillMdPlaceholder") : undefined}
              spellCheck={false}
              className="field-sizing-fixed h-[60vh] min-h-80 resize-y rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
            />
          </TabsContent>
          <TabsContent value="preview" className="h-[60vh] min-h-80 overflow-y-auto px-4 py-3">
            {content.trim() ? (
              <MessageResponse>{content}</MessageResponse>
            ) : (
              <p className="text-sm text-muted-foreground">{t("nothingToPreview")}</p>
            )}
          </TabsContent>

          {missing.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t bg-warning/10 px-4 py-1.5 text-xs">
              <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="text-muted-foreground">{t("missingRefs")}</span>
              {missing.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => addFile(p)}
                  aria-label={t("createMissing", { path: p })}
                  title={t("createMissing", { path: p })}
                  className="rounded font-mono underline decoration-dotted underline-offset-2 outline-none hover:text-foreground hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {p}
                </button>
              ))}
            </p>
          )}
          <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
            <span className="tabular">{t("characters", { count: content.length })}</span>
            <span className="tabular">{format.fileSize(byteLength(deferredContent))}</span>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

/** A path field in a popover, for new files and renames; folders are written with slashes. */
function PathPopover({
  label,
  submitLabel,
  paths,
  initial,
  current,
  onSubmit,
  trigger,
}: {
  label: string;
  submitLabel: string;
  paths: string[];
  initial: string;
  /** The path being renamed, which may keep its own name. */
  current?: string;
  onSubmit: (path: string) => void;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("skills.editor");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const path = normalizeSkillPath(value.trim());
    if (!path || path.endsWith("/")) return setError(t("pathInvalid"));
    if (path === current) return setOpen(false);
    // A file cannot share its path with another file or with a folder.
    const taken = paths.some((p) => p !== current && (p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`)));
    if (taken) return setError(t("pathTaken"));
    onSubmit(path);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(initial);
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Input
          id={id}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
          placeholder={t("pathPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={`${id}-hint`}
          className="font-mono text-sm"
        />
        <PopoverDescription id={`${id}-hint`} className={cn("text-xs", error && "text-destructive")}>
          {error ?? t("pathHint")}
        </PopoverDescription>
        <Button type="button" size="sm" className="self-end" onClick={submit}>
          {submitLabel}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

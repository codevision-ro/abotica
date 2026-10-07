"use client";

import type { FetchedSkill, SkillSourceRef } from "@abotica/core";
import { SKILL_MD, type SkillPackage } from "@abotica/core/skill-md";
import type { SkillOrigin } from "@abotica/db";
import { ChevronRightIcon, ExternalLinkIcon, FilesIcon, HardDriveIcon, InfoIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { installSkill } from "@/server/actions/skills";
import { SkillFileTree, skillFileIcon } from "./skill-file-tree";
import { SkillIcon } from "./skill-icon";

const MARKDOWN = /\.(md|markdown)$/i;

/** Where the previewed skill comes from: a remote source (linked) or the user's computer. */
export type SkillPreviewSource = { kind: "remote"; origin: SkillOrigin } | { kind: "local"; label: string };

/**
 * Read-only look at a skill folder before it is added: what it is, where it comes from and every
 * file, SKILL.md first. Key it by the skill so the selected file resets.
 */
export function SkillPreview({
  pkg,
  skipped,
  source,
  className,
}: {
  pkg: SkillPackage;
  skipped: string[];
  source: SkillPreviewSource;
  className?: string;
}) {
  const t = useTranslations("skills.preview");
  const format = useFormat();
  const [selected, setSelected] = useState(SKILL_MD);
  const [raw, setRaw] = useState(false);
  const paths = useMemo(() => pkg.files.map((f) => f.path), [pkg.files]);
  const bytes = useMemo(
    () => pkg.files.reduce((sum, f) => sum + new TextEncoder().encode(f.content).length, 0),
    [pkg.files],
  );
  const file = pkg.files.find((f) => f.path === selected) ?? pkg.files[0];
  const markdown = !!file && MARKDOWN.test(file.path);
  const extras = Object.entries(pkg.metadata);

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div className="flex items-center gap-3">
        <SkillIcon size="xl" />
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-lg leading-snug font-semibold tracking-tight wrap-anywhere">{pkg.name}</h3>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {source.kind === "remote" ? (
              <a
                href={source.origin.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
              >
                <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate font-mono">{source.origin.url.replace(/^https?:\/\//, "")}</span>
              </a>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5" title={t("local")}>
                <HardDriveIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate font-mono">{source.label}</span>
              </span>
            )}
            <span className="tabular inline-flex items-center gap-1.5">
              <FilesIcon className="size-3.5" aria-hidden />
              {t("files", { count: pkg.files.length })} · {format.fileSize(bytes)}
            </span>
          </div>
        </div>
      </div>

      <p className={cn("text-sm text-pretty wrap-anywhere", !pkg.description && "text-muted-foreground")}>
        {pkg.description || t("noDescription")}
      </p>

      {extras.length > 0 && (
        <dl aria-label={t("frontmatter")} className="flex flex-wrap gap-1.5">
          {extras.map(([key, value]) => {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            return (
              <div
                key={key}
                title={`${key}: ${text}`}
                className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs"
              >
                <dt className="shrink-0 text-muted-foreground">{key}</dt>
                <dd className="truncate font-mono">{text}</dd>
              </div>
            );
          })}
        </dl>
      )}

      <p className="flex gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-pretty text-muted-foreground">
        <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        {t("note")}
      </p>

      {skipped.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group/skipped flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRightIcon
              className="size-3.5 transition-transform group-data-[state=open]/skipped:rotate-90"
              aria-hidden
            />
            {t("skipped", { count: skipped.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 flex max-h-32 flex-col gap-0.5 overflow-y-auto pl-4.5 font-mono text-xs text-muted-foreground">
              {skipped.map((path) => (
                <li key={path} className="truncate" title={path}>
                  {path}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="grid h-[min(60dvh,36rem)] min-h-72 grid-rows-1 overflow-hidden rounded-xl border bg-card md:grid-cols-[13rem_minmax(0,1fr)] dark:bg-input/20">
        <div className="hidden min-h-0 overflow-y-auto border-r p-1.5 md:block">
          <SkillFileTree paths={paths} selected={file?.path ?? null} onSelect={setSelected} label={t("filesLabel")} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/30 px-2">
            <Select value={file?.path} onValueChange={setSelected}>
              <SelectTrigger size="sm" aria-label={t("fileSelect")} className="min-w-0 flex-1 font-mono text-xs md:hidden">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paths.map((path) => {
                  const Icon = skillFileIcon(path);
                  return (
                    <SelectItem key={path} value={path} className="font-mono text-xs">
                      <Icon aria-hidden /> {path}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <span className="hidden min-w-0 flex-1 truncate px-2 font-mono text-xs text-muted-foreground md:block">
              {file?.path}
            </span>
            {markdown && (
              <ToggleGroup
                type="single"
                size="sm"
                value={raw ? "raw" : "rendered"}
                onValueChange={(v) => v && setRaw(v === "raw")}
                aria-label={t("view")}
                className="shrink-0"
              >
                <ToggleGroupItem value="rendered" className="text-xs">
                  {t("rendered")}
                </ToggleGroupItem>
                <ToggleGroupItem value="raw" className="text-xs">
                  {t("raw")}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {!file?.content.trim() ? (
              <p className="text-sm text-muted-foreground">{t("emptyFile")}</p>
            ) : markdown && !raw ? (
              <MessageResponse className="text-sm">{file.content}</MessageResponse>
            ) : (
              <pre
                className={cn(
                  "font-mono text-xs leading-relaxed",
                  markdown ? "whitespace-pre-wrap wrap-anywhere" : "w-max min-w-full whitespace-pre",
                )}
              >
                {file.content}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mirrors `SkillPreview` while a remote skill loads. */
export function SkillPreviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48 max-w-full" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
      <Skeleton className="h-[min(60dvh,36rem)] min-h-72 w-full rounded-xl" />
    </div>
  );
}

/** The ref that fetches this origin again, for installing exactly what was previewed. */
export function skillSourceRef(origin: SkillOrigin): SkillSourceRef {
  return origin.kind === "skills.sh"
    ? { kind: "skills.sh", id: origin.id }
    : { kind: "github", repo: origin.repo, ref: origin.ref, path: origin.path };
}

/** Same key as `listInstalledSources`: the skills.sh id, or "owner/repo:path" for GitHub. */
export function skillSourceKey(origin: SkillOrigin): string {
  return origin.kind === "skills.sh" ? origin.id : `${origin.repo}:${origin.path}`;
}

/** Installs a previewed remote skill, pinned to the files the user saw, then opens it. */
export function useInstallSkill() {
  const t = useTranslations("skills.preview");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function install(fetched: FetchedSkill) {
    startTransition(async () => {
      const res = await installSkill({ ref: skillSourceRef(fetched.source), expectedHash: fetched.source.hash });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("installedToast", { name: fetched.pkg.name }));
      router.push(`/skills/${res.data.id}`);
    });
  }
  return { install, pending };
}

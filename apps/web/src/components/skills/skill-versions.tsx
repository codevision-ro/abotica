import { structuredPatch, type StructuredPatchHunk } from "diff";
import { GitCompareIcon, HistoryIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionList } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getSkillVersionDiff, listSkillVersions } from "@/server/queries/skills";
import { RestoreSkillVersionButton } from "./skill-version-actions";
import { type DiffRow, type FileDiff, FileStatusMark, SkillVersionFiles } from "./skill-version-diff";

/** Unchanged lines kept around each change; the rest is folded. */
const CONTEXT_LINES = 3;
/** File chips shown per version in the list before "+N more". */
const LIST_FILE_CHIPS = 4;

function lineCount(text: string) {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function lines(text: string) {
  return text ? text.replace(/\n$/, "").split("\n") : [];
}

/** Unified diff rows of one file: the changed lines with a few lines of context, the rest folded into gaps. */
function diffRows(before: string, after: string): DiffRow[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: CONTEXT_LINES, timeout: 1000 });
  // Too many changes to align in time: everything removed, then everything added.
  const hunks: StructuredPatchHunk[] = patch?.hunks ?? [
    {
      oldStart: 1,
      oldLines: lineCount(before),
      newStart: 1,
      newLines: lineCount(after),
      lines: [...lines(before).map((l) => `-${l}`), ...lines(after).map((l) => `+${l}`)],
    },
  ];
  const rows: DiffRow[] = [];
  // Last line of the old file a hunk covered.
  let oldEnd = 0;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    if (oldLine - oldEnd > 1) rows.push({ type: "gap", count: oldLine - oldEnd - 1 });
    for (const line of hunk.lines) {
      const text = line.slice(1);
      // "\ No newline at end of file" markers are skipped.
      if (line[0] === "+") rows.push({ type: "add", text, newLine: newLine++ });
      else if (line[0] === "-") rows.push({ type: "del", text, oldLine: oldLine++ });
      else if (line[0] === " ") rows.push({ type: "same", text, oldLine: oldLine++, newLine: newLine++ });
    }
    oldEnd = oldLine - 1;
  }
  const rest = lineCount(before) - oldEnd;
  if (rest > 0) rows.push({ type: "gap", count: rest });
  return rows;
}

/** A frontmatter value on one line: strings as they are, anything else as JSON. */
function metadataValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Per metadata key that differs: added, removed or changed, with both values on one line (null when unset). */
function diffMetadata(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    if (key in before && key in after && JSON.stringify(before[key]) === JSON.stringify(after[key])) return [];
    const was = key in before ? metadataValue(before[key]) : null;
    const now = key in after ? metadataValue(after[key]) : null;
    const status = was === null ? "added" : now === null ? "removed" : "changed";
    return [{ key, status, before: was, after: now } as const];
  });
}

export async function SkillVersionsTab({ skillId, version }: { skillId: string; version?: number }) {
  const [versions, t] = await Promise.all([listSkillVersions(skillId), getTranslations("skills.versions")]);
  const currentVersion = versions[0]?.version;
  const picked = versions.find((v) => v.version === version);
  const diff = picked ? await getSkillVersionDiff(skillId, picked.version) : null;
  const files: FileDiff[] = (diff?.files ?? []).map((f) => {
    const rows = diffRows(f.before, f.after);
    return {
      path: f.path,
      status: f.status,
      rows,
      added: rows.filter((r) => r.type === "add").length,
      removed: rows.filter((r) => r.type === "del").length,
    };
  });
  const metadata = diff ? diffMetadata(diff.metadata.before, diff.metadata.after) : [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const base = `/skills/${skillId}?tab=versions`;

  return (
    <div className="flex flex-col gap-6">
      <SectionCard icon={HistoryIcon} title={t("title")} count={versions.length} description={t("description")} flush>
        {versions.length > 1 ? (
          <SectionList>
            {versions.map((v) => {
              const isCurrent = v.version === currentVersion;
              const isSelected = v.version === picked?.version;
              const fields = v.changed.filter((c) => c !== "files");
              const chips = v.files.slice(0, LIST_FILE_CHIPS);
              return (
                <li
                  key={v.version}
                  className={cn(
                    "relative flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30 sm:px-5",
                    isSelected && "bg-primary/5 hover:bg-primary/5 dark:bg-primary/10",
                  )}
                >
                  <span
                    className={cn(
                      "tabular flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
                      isCurrent ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    v{v.version}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* The whole row selects the version; the restore button sits above the link. */}
                      <Link
                        href={isSelected ? base : `${base}&v=${v.version}#version-diff`}
                        scroll={isSelected ? false : undefined}
                        aria-current={isSelected ? "true" : undefined}
                        aria-label={isSelected ? t("hide") : t("show", { version: v.version })}
                        title={v.note || undefined}
                        className="truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                      >
                        {v.note || <span className="font-normal text-muted-foreground">{t("noNote")}</span>}
                      </Link>
                      {isCurrent && (
                        <Badge variant="secondary" className="shrink-0 bg-primary/10 font-normal text-primary">
                          {t("current")}
                        </Badge>
                      )}
                    </div>
                    <RelativeTime date={v.createdAt} className="block text-xs text-muted-foreground" />
                    {(fields.length > 0 || chips.length > 0) && (
                      <ul className="mt-1.5 flex flex-wrap gap-1">
                        {fields.map((field) => (
                          <li key={field} className={chipClass}>
                            {t(`fields.${field}`)}
                          </li>
                        ))}
                        {chips.map((f) => (
                          <li key={f.path} className={cn(chipClass, "max-w-full font-mono")} title={f.path}>
                            <FileStatusMark status={f.status} label={t(`status.${f.status}`)} />
                            <span className="truncate">{f.path}</span>
                          </li>
                        ))}
                        {v.files.length > chips.length && (
                          <li className={cn(chipClass, "text-muted-foreground")}>
                            {t("moreFiles", { count: v.files.length - chips.length })}
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                  {!isCurrent && (
                    <div className="relative z-10 shrink-0">
                      <RestoreSkillVersionButton id={skillId} version={v.version} />
                    </div>
                  )}
                </li>
              );
            })}
          </SectionList>
        ) : (
          <SectionEmpty>{t("single", { version: currentVersion ?? 1 })}</SectionEmpty>
        )}
      </SectionCard>

      {picked && diff && (
        <div id="version-diff" className="scroll-mt-20">
          <SectionCard
            icon={GitCompareIcon}
            title={t("diffTitle", { version: diff.version })}
            description={
              diff.previousVersion === null ? t("diffFirst") : t("diffDescription", { previous: diff.previousVersion })
            }
            action={
              files.length > 0 && (
                <span className="tabular flex gap-1.5 text-sm font-medium" title={t("lineStats", { added, removed })}>
                  <span className="text-success">+{added}</span>
                  <span className="text-destructive">-{removed}</span>
                </span>
              )
            }
          >
            <div className="flex flex-col gap-5">
              {diff.previousVersion !== null &&
                (["name", "description"] as const).map(
                  (key) =>
                    diff[key].before !== diff[key].after && (
                      <div key={key} className="flex flex-col gap-2">
                        <h3 className="text-sm font-medium">{t(`fields.${key}`)}</h3>
                        <div className="grid gap-2 md:grid-cols-2">
                          <FieldValue title={t("before")} value={diff[key].before || t("empty")} tone="old" />
                          <FieldValue title={t("after")} value={diff[key].after || t("empty")} tone="new" />
                        </div>
                      </div>
                    ),
                )}
              {diff.previousVersion !== null && metadata.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{t("fields.metadata")}</h3>
                  <ul className="flex flex-col gap-3">
                    {metadata.map((m) => (
                      <li key={m.key} className="flex min-w-0 flex-col gap-1.5">
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                          <FileStatusMark status={m.status} label={t(`status.${m.status}`)} />
                          <span className="truncate" title={m.key}>
                            {m.key}
                          </span>
                        </span>
                        <div className="grid gap-2 md:grid-cols-2">
                          <FieldValue
                            title={t("before")}
                            value={m.before ?? t("notSet")}
                            tone="old"
                            mono={m.before !== null}
                          />
                          <FieldValue
                            title={t("after")}
                            value={m.after ?? t("notSet")}
                            tone="new"
                            mono={m.after !== null}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {files.length > 0 ? (
                <SkillVersionFiles files={files} />
              ) : (
                <p className="text-sm text-muted-foreground">{t("noFileChanges")}</p>
              )}
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}

const chipClass =
  "inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 text-[11px] leading-none";

function FieldValue({ title, value, tone, mono }: { title: string; value: string; tone: "old" | "new"; mono?: boolean }) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        tone === "old"
          ? "border-destructive/20 bg-destructive/[0.04] dark:bg-destructive/[0.08]"
          : "border-success/25 bg-success/[0.05] dark:bg-success/[0.08]",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", tone === "old" ? "bg-destructive/70" : "bg-success")} />
        {title}
      </div>
      <p className={cn("whitespace-pre-wrap wrap-anywhere", mono ? "font-mono text-xs leading-relaxed" : "text-sm")}>
        {value}
      </p>
    </div>
  );
}

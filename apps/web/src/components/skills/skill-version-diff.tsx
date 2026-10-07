"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { createElement, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkillFileTree, skillFileIcon } from "./skill-file-tree";

export type FileStatus = "added" | "removed" | "changed";

/** One row of a unified diff; `gap` stands for unchanged lines left out. */
export type DiffRow =
  | { type: "add"; text: string; newLine: number }
  | { type: "del"; text: string; oldLine: number }
  | { type: "same"; text: string; oldLine: number; newLine: number }
  | { type: "gap"; count: number };

export type FileDiff = { path: string; status: FileStatus; rows: DiffRow[]; added: number; removed: number };

/** Rows rendered before "Show all", so a rewritten large file does not stall the page. */
const ROW_LIMIT = 400;

const STATUS_LETTER = { added: "A", removed: "D", changed: "M" } as const;
const STATUS_COLOR = {
  added: "text-success",
  removed: "text-destructive",
  changed: "text-[color-mix(in_oklch,var(--warning),black_30%)] dark:text-warning",
} as const;

/** A, M or D in the status color, with the full word for screen readers and on hover. */
export function FileStatusMark({ status, label }: { status: FileStatus; label: string }) {
  return (
    <span title={label} className={cn("font-mono text-[11px] font-semibold", STATUS_COLOR[status])}>
      <span aria-hidden>{STATUS_LETTER[status]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The changed files of a version: a tree to pick one (when there are several) and its line diff. */
export function SkillVersionFiles({ files }: { files: FileDiff[] }) {
  const t = useTranslations("skills.versions");
  const [selected, setSelected] = useState(files[0]!.path);
  const file = files.find((f) => f.path === selected) ?? files[0]!;
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const marks = useMemo(
    () =>
      Object.fromEntries(
        files.map((f) => [f.path, <FileStatusMark key={f.path} status={f.status} label={t(`status.${f.status}`)} />]),
      ),
    [files, t],
  );

  return (
    <div className={cn("grid min-w-0 gap-4", files.length > 1 && "lg:grid-cols-[15rem_minmax(0,1fr)]")}>
      {files.length > 1 && (
        <SkillFileTree
          paths={paths}
          selected={file.path}
          onSelect={setSelected}
          marks={marks}
          label={t("filesLabel")}
          className="max-h-56 overflow-y-auto rounded-xl border border-border/70 p-1 lg:sticky lg:top-20 lg:max-h-[calc(100svh-7rem)] lg:self-start"
        />
      )}
      <FileDiffView key={file.path} file={file} />
    </div>
  );
}

function FileDiffView({ file }: { file: FileDiff }) {
  const t = useTranslations("skills.versions");
  const [all, setAll] = useState(false);
  const lineRows = file.rows.filter((r) => r.type !== "gap").length;
  const rows = all ? file.rows : file.rows.slice(0, ROW_LIMIT);

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border/70">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2">
        {createElement(skillFileIcon(file.path), {
          "aria-hidden": true,
          className: "size-4 shrink-0 text-muted-foreground",
        })}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        <FileStatusMark status={file.status} label={t(`status.${file.status}`)} />
        <span
          className="tabular flex shrink-0 gap-1.5 text-xs font-medium"
          title={t("lineStats", { added: file.added, removed: file.removed })}
        >
          <span className="text-success">+{file.added}</span>
          <span className="text-destructive">-{file.removed}</span>
        </span>
      </div>
      {file.rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {rows.map((row, i) =>
                row.type === "gap" ? (
                  <tr key={i} className="bg-muted/40 text-muted-foreground">
                    <td colSpan={4} className="sticky left-0 px-3 py-0.5 font-sans">
                      <span className="inline-flex items-center gap-1.5">
                        <ChevronsUpDownIcon aria-hidden className="size-3" />
                        {t("unchanged", { count: row.count })}
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={i}
                    className={cn(
                      row.type === "add" && "bg-success/10 dark:bg-success/12",
                      row.type === "del" && "bg-destructive/8 dark:bg-destructive/12",
                    )}
                  >
                    <LineNumber value={row.type === "add" ? undefined : row.oldLine} />
                    <LineNumber value={row.type === "del" ? undefined : row.newLine} />
                    <td
                      className={cn(
                        "w-5 pl-2 select-none",
                        row.type === "add" && "text-success",
                        row.type === "del" && "text-destructive",
                      )}
                    >
                      {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
                    </td>
                    <td className="pr-4 whitespace-pre">{row.text}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-3 py-2.5 text-sm text-muted-foreground">{t("emptyFile")}</p>
      )}
      {rows.length < file.rows.length && (
        <div className="border-t border-border/70 px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
            <ChevronsUpDownIcon /> {t("showAll", { count: lineRows })}
          </Button>
        </div>
      )}
    </div>
  );
}

function LineNumber({ value }: { value: number | undefined }) {
  return (
    <td
      aria-hidden
      className="tabular hidden w-px border-r border-border/50 px-2 text-right text-muted-foreground/70 select-none sm:table-cell"
    >
      {value}
    </td>
  );
}

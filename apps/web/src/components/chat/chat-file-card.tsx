"use client";

import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoCameraIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { SectionIcon } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";

/** Output of the `file_share` tool. */
type SharedFile = { id: string; name: string; mimeType: string; size: number };

/** A stored file as the chat shows it; the size is unknown for a file sent from another tab or channel. */
type CardFile = { id: string; name: string; mimeType: string; size?: number | null };

export function sharedFile(output: unknown): SharedFile | null {
  if (typeof output !== "object" || output === null) return null;
  const { id, name, mimeType, size } = output as Record<string, unknown>;
  return typeof id === "string" && typeof name === "string" && typeof mimeType === "string" && typeof size === "number"
    ? { id, name, mimeType, size }
    : null;
}

const SHEET_RE = /spreadsheet|excel|csv/;
const ARCHIVE_RE = /zip|tar|gzip|x-7z|rar|compressed/;
const CODE_RE = /json|javascript|typescript|xml|x-python|x-sh|yaml|html|css/;

const FILE_ICONS = {
  image: FileImageIcon,
  video: FileVideoCameraIcon,
  audio: FileAudioIcon,
  sheet: FileSpreadsheetIcon,
  archive: FileArchiveIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  other: FileIcon,
} satisfies Record<string, LucideIcon>;

function fileKind(mimeType: string): keyof typeof FILE_ICONS {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (SHEET_RE.test(mimeType)) return "sheet";
  if (ARCHIVE_RE.test(mimeType)) return "archive";
  if (CODE_RE.test(mimeType)) return "code";
  if (mimeType.startsWith("text/") || mimeType === "application/pdf") return "text";
  return "other";
}

/** "PDF", "PNG": the extension, or the media subtype when the name has none. */
function typeLabel(file: CardFile): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1) : (file.mimeType.split("/")[1] ?? "");
  return ext.slice(0, 12).toUpperCase();
}

const downloadUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;

/**
 * A stored file in the chat (one the user sent or an agent shared): preview for images, name, size
 * and a download link.
 */
export function ChatFileCard({ file, className }: { file: CardFile; className?: string }) {
  const t = useTranslations("files");
  const f = useFormat();
  const url = downloadUrl(file.id);
  const Icon = FILE_ICONS[fileKind(file.mimeType)];
  const meta = [file.size == null ? null : f.fileSize(file.size), typeLabel(file)].filter(Boolean).join(" · ");

  return (
    <div className={cn("mx-3 mb-3 max-w-md overflow-hidden rounded-lg border bg-card dark:bg-input/10", className)}>
      {file.mimeType.startsWith("image/") && (
        <a href={url} download={file.name} aria-label={t("downloadName", { name: file.name })} className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={file.name} loading="lazy" className="max-h-72 w-full bg-muted/30 object-contain" />
        </a>
      )}
      <div className="flex min-w-0 items-center gap-3 p-2.5">
        <SectionIcon icon={Icon} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="tabular truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={url} download={file.name} aria-label={t("downloadName", { name: file.name })}>
            <DownloadIcon />
            <span className="hidden sm:inline">{t("download")}</span>
          </a>
        </Button>
      </div>
    </div>
  );
}

/** A compact download link for a file, e.g. one a delegated task produced. */
export function ChatFileChip({ file }: { file: CardFile }) {
  const t = useTranslations("files");
  const f = useFormat();
  const Icon = FILE_ICONS[fileKind(file.mimeType)];
  return (
    <a
      href={downloadUrl(file.id)}
      download={file.name}
      aria-label={t("downloadName", { name: file.name })}
      title={file.name}
      className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 text-xs transition-colors outline-none hover:border-primary/30 hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="max-w-48 min-w-0 truncate">{file.name}</span>
      {file.size != null && <span className="tabular shrink-0 text-muted-foreground">{f.fileSize(file.size)}</span>}
      <DownloadIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </a>
  );
}

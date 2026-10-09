/** File names and media types of files agents share. Pure, no server imports. */

const MIME_BY_EXTENSION: Record<string, string> = {
  // Text and data
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "application/sql",
  ics: "text/calendar",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  // Audio and video
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
};

const FALLBACK_MIME = "application/octet-stream";

/** Media type from the file name's extension; unknown extensions are generic binary. */
export function mimeTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return FALLBACK_MIME;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? FALLBACK_MIME;
}

/** Extension for a media type, for files that arrive without a usable name (some files sent to the Telegram bot). */
export function extensionFor(mimeType: string): string | null {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "text/plain") return "txt";
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) if (mime === type) return ext;
  return null;
}

/** A name safe as a single path segment: no folders, no control or shell-hostile characters. */
export function safeFileName(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-120);
  return cleaned || fallback;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_URL_RE = /^\/api\/files\/([^/?#]+)$/;

/** URL the web app serves a stored file at. */
export const fileUrl = (id: string) => `/api/files/${id}`;

/**
 * The id of a file the app stores itself, from its URL: a path (`/api/files/<id>`) or a URL on one of
 * `origins`. Null for anything else, e.g. a data URL or another site's file.
 */
export function fileIdFromUrl(url: string, origins: string[] = []): string | null {
  let pathname = url;
  if (!url.startsWith("/")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!origins.some((origin) => origin.replace(/\/$/, "") === parsed.origin)) return null;
    pathname = parsed.pathname;
  }
  const id = FILE_URL_RE.exec(pathname)?.[1];
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/sql",
  "application/javascript",
  "application/x-sh",
]);

/** Whether a file is plain text a model can read as is (source, data, markup), judged by type and name. */
export function isTextFile(mimeType: string, name: string): boolean {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("text/") || TEXT_MIME_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml")) {
    return type !== "image/svg+xml";
  }
  const byName = mimeTypeFor(name);
  return byName.startsWith("text/") || TEXT_MIME_TYPES.has(byName);
}

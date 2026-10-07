/**
 * What the model gets of the files in a conversation. Messages point at stored files
 * (`/api/files/<id>`), which no provider can fetch; before the history goes to the model, every user
 * file part becomes a note naming the file (and its path in the workspace), followed by what a model
 * can read of it: the text of a text file, the bytes of an image or PDF within a size budget, newest
 * files first. In memory only, like the sent times: the stored messages keep their file parts. The
 * file store is passed in, so this stays free of database and disk access.
 */
import type { FileUIPart, UIMessage } from "ai";
import { fileIdFromUrl, isTextFile } from "../files/file-types";
import type { StoredFile } from "../files/files";
import { inputPath } from "./workspace-paths";

const MB = 1024 * 1024;

/** Characters of a text file shown in its note (about 5k tokens); the rest stays in the workspace. */
export const TEXT_INLINE_MAX_CHARS = 20_000;

/**
 * Largest image sent as bytes. Anthropic takes up to 10 MB per image, base64-encoded, which is about
 * 7.5 MB of bytes (https://platform.claude.com/docs/en/build-with-claude/vision#request-limits).
 */
export const IMAGE_INLINE_MAX_BYTES = 5 * MB;

/**
 * Largest PDF sent as bytes. Anthropic allows 32 MB per request, everything included
 * (https://platform.claude.com/docs/en/build-with-claude/pdf-support), OpenAI 50 MB for all files
 * of a request (https://developers.openai.com/api/docs/guides/file-inputs#usage-considerations).
 */
export const PDF_INLINE_MAX_BYTES = 10 * MB;

/**
 * Bytes of all files sent in one request. Base64 turns 16 MB into about 21 MB, which leaves room for
 * the rest of the history under Anthropic's 32 MB request limit.
 */
export const INLINE_TOTAL_MAX_BYTES = 16 * MB;

/**
 * Files sent as bytes in one request. Above 20 images Anthropic rejects every image larger than
 * 2000 px a side (vision docs, request limits), and the images are not resized here.
 */
export const INLINE_MAX_FILES = 20;

/** Types sent as bytes, with their size limit: the image formats Anthropic and OpenAI both take, and PDF. */
const INLINE_MAX_BYTES: Record<string, number> = {
  "image/jpeg": IMAGE_INLINE_MAX_BYTES,
  "image/png": IMAGE_INLINE_MAX_BYTES,
  "image/gif": IMAGE_INLINE_MAX_BYTES,
  "image/webp": IMAGE_INLINE_MAX_BYTES,
  "application/pdf": PDF_INLINE_MAX_BYTES,
};

export type FileInfo = Pick<StoredFile, "id" | "name" | "mimeType" | "size">;

export type FileStore = {
  /** The stored file, or null when it no longer exists. */
  get(id: string): Promise<FileInfo | null>;
  /** Its bytes (only the first `maxBytes` when given), or null when they are gone. */
  read(id: string, maxBytes?: number): Promise<Uint8Array | null>;
};

export type ModelFilesOptions = {
  store: FileStore;
  /** Whether the run has a workspace; it holds every stored file of the messages at `inputPath`. */
  workspace: boolean;
  /** Whether a model of the run reads files of this media type directly; other files are never loaded. */
  readsDirectly(mediaType: string): Promise<boolean>;
};

type FileRef = { message: number; part: number; file: FileUIPart; id: string | null };

/** How a file is shown: its bytes, its text, or only the note (with why, when it says so). */
type Plan =
  | { show: "bytes" }
  | { show: "text" }
  | { show: "note"; why?: keyof typeof NOTE_REASONS | "repeated" }
  | { show: "gone" }
  | { show: "unstored" };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

/** The start of a text file, decoded, at most `maxChars` characters; `cut` when there is more. */
export function clipText(data: Uint8Array, maxChars: number): { text: string; cut: boolean } {
  // A character takes at most 4 bytes in UTF-8, so this decodes no more than needed.
  const head = data.subarray(0, maxChars * 4);
  const text = new TextDecoder().decode(head);
  if (text.length > maxChars) return { text: text.slice(0, maxChars), cut: true };
  return { text, cut: head.length < data.length };
}

function fileRefs(messages: UIMessage[]): FileRef[] {
  const refs: FileRef[] = [];
  messages.forEach((message, m) => {
    if (message.role !== "user") return;
    message.parts.forEach((part, p) => {
      if (part.type === "file") refs.push({ message: m, part: p, file: part, id: fileIdFromUrl(part.url) });
    });
  });
  return refs;
}

/**
 * Decides, newest file first, which files are sent as bytes until the budget runs out; a file that
 * appears again later is shown there only.
 */
async function planFiles(
  refs: FileRef[],
  infos: Map<string, FileInfo | null>,
  readsDirectly: (mediaType: string) => Promise<boolean>,
): Promise<Plan[]> {
  const plans: Plan[] = new Array(refs.length);
  const newest = new Map<string, Plan>();
  let bytes = 0;
  let count = 0;
  for (let i = refs.length - 1; i >= 0; i--) {
    const { id } = refs[i]!;
    const info = id ? infos.get(id) : undefined;
    if (!id) plans[i] = { show: "unstored" };
    else if (!info) plans[i] = { show: "gone" };
    else if (newest.has(id)) {
      const shown = newest.get(id)!;
      plans[i] = shown.show === "bytes" || shown.show === "text" ? { show: "note", why: "repeated" } : shown;
    } else if (isTextFile(info.mimeType, info.name)) plans[i] = { show: "text" };
    else {
      const max = INLINE_MAX_BYTES[info.mimeType];
      if (!max || !(await readsDirectly(info.mimeType))) plans[i] = { show: "note" };
      else if (info.size > max) plans[i] = { show: "note", why: "too-large" };
      else if (count >= INLINE_MAX_FILES || bytes + info.size > INLINE_TOTAL_MAX_BYTES) {
        plans[i] = { show: "note", why: "budget" };
      } else {
        plans[i] = { show: "bytes" };
        bytes += info.size;
        count += 1;
      }
    }
    if (id && info && !newest.has(id)) newest.set(id, plans[i]!);
  }
  return plans;
}

const NOTE_REASONS = {
  "too-large": " Too large to show here.",
  budget: " No longer shown here, to leave room for newer files.",
};

const quoted = (name: string) => JSON.stringify(name);

/** The parts that stand for one file part. */
function filePartsFor(
  ref: FileRef,
  info: FileInfo | null | undefined,
  plan: Plan,
  data: Uint8Array | null | undefined,
  workspace: boolean,
): UIMessage["parts"] {
  const name = info?.name ?? ref.file.filename ?? "file";
  const mediaType = info?.mimeType ?? ref.file.mediaType;
  const note = (text: string) => ({ type: "text" as const, text });
  if (plan.show === "unstored") {
    return [note(`[Attached file ${quoted(name)} (${mediaType}): not a stored file, so its content is not available.]`)];
  }
  if (plan.show === "gone" || !info || ((plan.show === "bytes" || plan.show === "text") && !data)) {
    return [note(`[Attached file ${quoted(name)} (${mediaType}): the stored file no longer exists.]`)];
  }

  const where = workspace ? `, in the workspace at ${inputPath(info)}` : "";
  const head = `Attached file ${quoted(name)} (${mediaType}, ${formatSize(info.size)})${where}.`;
  if (plan.show === "bytes") {
    const url = `data:${mediaType};base64,${Buffer.from(data!).toString("base64")}`;
    return [note(`[${head}]`), { type: "file", mediaType, filename: name, url }];
  }
  if (plan.show === "text") {
    const { text, cut } = clipText(data!, TEXT_INLINE_MAX_CHARS);
    const limit = TEXT_INLINE_MAX_CHARS.toLocaleString("en-US");
    const end = cut ? `\n[Cut after ${limit} characters${workspace ? "; the whole file is in the workspace" : ""}.]` : "";
    return [note(`[${head} Its content:]\n${text}${end}`)];
  }

  if (plan.why === "repeated") return [note(`[${head} Shown again in a later message.]`)];
  const why = plan.why ? NOTE_REASONS[plan.why] : "";
  const open = workspace
    ? " Open it with the workspace tools if you need its content."
    : " Its content is not available in this run.";
  return [note(`[${head}${why}${open}]`)];
}

/** The messages with every user file part replaced by what the model should see of the file. */
export async function withModelFiles(messages: UIMessage[], options: ModelFilesOptions): Promise<UIMessage[]> {
  const refs = fileRefs(messages);
  if (!refs.length) return messages;

  const ids = [...new Set(refs.flatMap((r) => (r.id ? [r.id] : [])))];
  const infos = new Map(await Promise.all(ids.map(async (id) => [id, await options.store.get(id)] as const)));
  const plans = await planFiles(refs, infos, options.readsDirectly);
  // A text file is read only as far as it is shown, plus one byte to tell whether there is more.
  const toLoad = new Map<string, number | undefined>();
  refs.forEach((r, i) => {
    const { show } = plans[i]!;
    if (show === "bytes") toLoad.set(r.id!, undefined);
    else if (show === "text") toLoad.set(r.id!, TEXT_INLINE_MAX_CHARS * 4 + 1);
  });
  const data = new Map(
    await Promise.all([...toLoad].map(async ([id, maxBytes]) => [id, await options.store.read(id, maxBytes)] as const)),
  );

  const replaced = new Map(refs.map((ref, i) => [`${ref.message}/${ref.part}`, i]));
  return messages.map((message, m) => {
    if (message.role !== "user" || !message.parts.some((p) => p.type === "file")) return message;
    const parts = message.parts.flatMap((part, p) => {
      const i = replaced.get(`${m}/${p}`);
      if (i === undefined) return [part];
      const ref = refs[i]!;
      return filePartsFor(
        ref,
        ref.id ? infos.get(ref.id) : null,
        plans[i]!,
        ref.id ? data.get(ref.id) : null,
        options.workspace,
      );
    });
    return { ...message, parts };
  });
}

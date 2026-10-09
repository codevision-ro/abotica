/** Pure helpers of the workspace tools: output capture, text decoding, line ranges and edits. */

/** What a HeadTailText dropped: the text's full length and the characters kept at each end. */
export type TextCut = { totalChars: number; keptHead: number; keptTail: number };

/**
 * Collects a stream's text keeping the beginning and the end, so a long build log still shows how
 * it started and how it failed. Memory stays bounded however much the command prints.
 */
export class HeadTailText {
  private head = "";
  private tail = "";
  private total = 0;

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  push(chunk: string): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const take = rest.slice(0, this.headMax - this.head.length);
      this.head += take;
      rest = rest.slice(take.length);
    }
    if (rest) this.tail = (this.tail + rest).slice(-this.tailMax);
  }

  /** What was dropped from the middle, or null when the whole text was kept. */
  cut(): TextCut | null {
    const keptHead = this.head.length;
    const keptTail = this.tail.length;
    return this.total > keptHead + keptTail ? { totalChars: this.total, keptHead, keptTail } : null;
  }

  /** The kept text; when the middle was dropped, `notice` (given its length) stands on a line in its place. */
  text(notice: (omitted: number) => string): string {
    const omitted = this.total - this.head.length - this.tail.length;
    return omitted > 0 ? `${this.head}\n${notice(omitted)}\n${this.tail}` : this.head + this.tail;
  }
}

/** A HeadTailText of `max` characters, half from the start and half from the end. */
export const headTailText = (max: number) => new HeadTailText(Math.floor(max / 2), Math.ceil(max / 2));

/** A stream's text: the head and tail view, and the full text up to a byte limit. */
export type CollectedText = {
  view: HeadTailText;
  /** The text from the start, at most the byte limit of collectText. */
  full: () => string;
  /** False when the stream went on past the byte limit. */
  complete: boolean;
};

/**
 * Reads a whole stream as text into a HeadTailText of `max` characters, keeping its first
 * `fullMaxBytes` bytes as well, so the full text can be saved when the view is cut.
 */
export async function collectText(
  stream: ReadableStream<Uint8Array>,
  max: number,
  fullMaxBytes: number,
): Promise<CollectedText> {
  const view = headTailText(max);
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  for await (const chunk of stream) {
    view.push(decoder.decode(chunk, { stream: true }));
    const kept = chunk.subarray(0, fullMaxBytes - size);
    if (kept.byteLength < chunk.byteLength) complete = false;
    if (kept.byteLength) chunks.push(kept);
    size += kept.byteLength;
  }
  view.push(decoder.decode());
  return { view, full: () => new TextDecoder().decode(Buffer.concat(chunks)), complete };
}

/** Reads at most `max` bytes; null when the stream has more (the rest is cancelled). */
export async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** UTF-8 text, or null when the bytes look binary (NUL bytes or invalid UTF-8). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Lines `startLine`..`endLine` (1-based, inclusive, clamped) and the file's line count. */
export function sliceLines(text: string, startLine?: number, endLine?: number): { content: string; totalLines: number } {
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const totalLines = text === "" ? 0 : lines.length;
  if (startLine === undefined && endLine === undefined) return { content: text, totalLines };
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(totalLines, endLine ?? totalLines);
  return { content: start > end ? "" : lines.slice(start - 1, end).join("\n"), totalLines };
}

type EditResult = { content: string; replacements: number } | { error: string };

/**
 * Replaces `oldText` with `newText`. Without `replaceAll` the text must occur exactly once, so an
 * edit never lands in the wrong place; the error tells the model how to fix its call.
 */
export function applyEdit(content: string, oldText: string, newText: string, replaceAll = false): EditResult {
  if (!oldText) return { error: "oldText is empty. Use file_write to create or overwrite a file." };
  const count = content.split(oldText).length - 1;
  if (count === 0) {
    return { error: "oldText was not found. Read the file again and copy the text exactly, including whitespace." };
  }
  if (count > 1 && !replaceAll) {
    return {
      error: `oldText occurs ${count} times. Include more surrounding lines to make it unique, or set replaceAll.`,
    };
  }
  // split/join instead of replaceAll so "$&" and similar in newText stay literal.
  return { content: content.split(oldText).join(newText), replacements: count };
}

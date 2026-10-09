/**
 * Reads the tar archive a static preview is copied from. The archive comes from the sandbox, so it
 * is untrusted: only regular files are kept, under paths that stay inside the copy, within the
 * size and count limits. Links, devices and anything else are skipped and reported.
 */

export type SnapshotFile = { path: string; data: Uint8Array };

export type Snapshot = {
  files: SnapshotFile[];
  /** Entries left out (links, devices, unsafe paths), for the agent. */
  skipped: string[];
};

/** Most a static preview holds. */
export const PREVIEW_MAX_MB = 50;
export const PREVIEW_MAX_BYTES = PREVIEW_MAX_MB * 1024 * 1024;
const PREVIEW_MAX_FILES = 2000;

export class SnapshotTooLargeError extends Error {
  override name = "SnapshotTooLargeError";
}

const BLOCK = 512;
const decoder = new TextDecoder();

function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("Malformed tar header");
  return text ? Number.parseInt(text, 8) : 0;
}

/** The `path` of a pax extended header, if it has one. */
function paxPath(data: Uint8Array): string | null {
  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * A path inside the copy: relative, with `/` separators, no empty, `.` or `..` segments. Null when
 * the archive's path would not stay inside.
 */
export function safeSnapshotPath(raw: string): string | null {
  if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) return null;
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (!segments.length || segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

/** Files of a tar archive (ustar, GNU or pax headers), within the limits. */
export function readSnapshotTar(archive: Uint8Array): Snapshot {
  const files: SnapshotFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let longName: string | null = null;
  for (let offset = 0; offset + BLOCK <= archive.length;) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]!);
    const dataStart = offset + BLOCK;
    const data = archive.subarray(dataStart, dataStart + size);
    if (data.length < size) throw new Error("Truncated tar archive");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // GNU long names and pax headers describe the entry that follows.
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "g") continue;

    const prefix = field(header, 345, 155);
    const rawName = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    if (type === "5") continue;
    const path = safeSnapshotPath(rawName);
    if ((type !== "0" && type !== "\0") || !path) {
      skipped.push(rawName);
      continue;
    }
    total += size;
    if (files.length >= PREVIEW_MAX_FILES || total > PREVIEW_MAX_BYTES) {
      throw new SnapshotTooLargeError(`A preview holds at most ${PREVIEW_MAX_FILES} files and ${PREVIEW_MAX_MB} MB.`);
    }
    files.push({ path, data: data.slice() });
  }
  return { files, skipped };
}

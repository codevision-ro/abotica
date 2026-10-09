/**
 * Stored files: what the user uploads and what agents produce or hand to each other. The bytes live
 * in the uploads folder under `files/<id>`; the `files` row says what the file is and who owns it (a
 * conversation, a task or a knowledge item). Messages and tool results refer to a file by its URL
 * (`/api/files/<id>`), never carry its bytes.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, files } from "@abotica/db";
import { and, asc, eq, inArray, isNull, lt, or, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import type { FileUIPart, UIMessage } from "ai";
import { fileIdFromUrl, fileUrl, mimeTypeFor } from "./file-types";
import { FILE_MAX_BYTES } from "../platform/limits";
import { resolveUpload } from "./uploads";

export type StoredFile = typeof files.$inferSelect;
type FileSource = StoredFile["source"];

/** Who a file belongs to; it is deleted together with its owner. */
export type FileOwner = { conversationId: string } | { taskId: string } | { knowledgeItemId: string };

/** Uploads no owner claimed within this time are removed by the sweep. */
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;
/** Bytes on disk without a row are left alone this long: a save writes the bytes before the row. */
const ORPHAN_GRACE_MS = 3600 * 1000;
const FILES_DIR = "files";
const NAME_MAX_LENGTH = 200;

/** Absolute path of a file's bytes. */
export function filePath(id: string): string {
  const file = resolveUpload(path.join(FILES_DIR, id));
  if (!file || path.basename(file) !== id) throw new Error(`Invalid file id ${id}`);
  return file;
}

const ownerColumns = (owner: FileOwner | null) => ({
  conversationId: owner && "conversationId" in owner ? owner.conversationId : null,
  taskId: owner && "taskId" in owner ? owner.taskId : null,
  knowledgeItemId: owner && "knowledgeItemId" in owner ? owner.knowledgeItemId : null,
});

const ownerCondition = (owner: FileOwner): SQL =>
  "conversationId" in owner
    ? eq(files.conversationId, owner.conversationId)
    : "taskId" in owner
      ? eq(files.taskId, owner.taskId)
      : eq(files.knowledgeItemId, owner.knowledgeItemId);

const unowned = () => and(isNull(files.conversationId), isNull(files.taskId), isNull(files.knowledgeItemId));

/** The name a file is stored under: its last path segment, trimmed, never empty. */
function cleanName(name: string): string {
  const base = name.trim().split(/[\\/]/).pop()?.trim() ?? "";
  return (base || "file").slice(-NAME_MAX_LENGTH);
}

/**
 * Stores a file. `owner` null makes it a pending upload that a message, task or knowledge item claims
 * later with `claimFiles`. The media type comes from the name when it is known there, since the
 * declared one is often missing or generic.
 */
export async function saveFile(input: {
  name: string;
  data: Uint8Array;
  source: FileSource;
  owner: FileOwner | null;
  mimeType?: string | null;
  runId?: string | null;
  agentId?: string | null;
}): Promise<StoredFile> {
  const name = cleanName(input.name);
  if (input.data.byteLength > FILE_MAX_BYTES) {
    throw new UserError("files.errors.tooLarge", { name, max: FILE_MAX_BYTES / (1024 * 1024) });
  }
  const byName = mimeTypeFor(name);
  const declared = input.mimeType?.split(";")[0]?.trim().toLowerCase();
  const mimeType = byName !== "application/octet-stream" ? byName : declared || byName;

  const id = randomUUID();
  const file = filePath(id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, input.data);
  try {
    const [row] = await db
      .insert(files)
      .values({
        id,
        name,
        mimeType,
        size: input.data.byteLength,
        source: input.source,
        ...ownerColumns(input.owner),
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
      })
      .returning();
    return row!;
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

export async function getFile(id: string): Promise<StoredFile | null> {
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row ?? null;
}

/** The file's bytes (only the first `maxBytes` when given), or null when they are no longer on disk. */
export async function readFileBytes(id: string, maxBytes?: number): Promise<Uint8Array | null> {
  try {
    if (maxBytes === undefined) {
      const data = await readFile(filePath(id));
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const handle = await open(filePath(id));
    try {
      const buffer = new Uint8Array(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Files matching every given field, oldest first. */
export async function listFiles(filter: {
  conversationId?: string;
  taskId?: string;
  runId?: string;
  source?: FileSource;
}): Promise<StoredFile[]> {
  const conditions: SQL[] = [];
  if (filter.conversationId) conditions.push(eq(files.conversationId, filter.conversationId));
  if (filter.taskId) conditions.push(eq(files.taskId, filter.taskId));
  if (filter.runId) conditions.push(eq(files.runId, filter.runId));
  if (filter.source) conditions.push(eq(files.source, filter.source));
  if (!conditions.length) throw new Error("listFiles needs a filter");
  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(asc(files.createdAt));
}

/**
 * Gives pending uploads to an owner, in the order of `ids`. A file the owner already has is
 * returned as is, so a retried request does not fail. Any other file fails the whole claim.
 */
export async function claimFiles(ids: string[], owner: FileOwner): Promise<StoredFile[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(files)
      .set(ownerColumns(owner))
      .where(and(inArray(files.id, unique), or(and(unowned(), eq(files.source, "user")), ownerCondition(owner))))
      .returning();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = unique.find((id) => !byId.has(id));
    if (missing) {
      const [row] = await tx.select({ name: files.name }).from(files).where(eq(files.id, missing));
      throw new UserError(row ? "files.errors.notAttachable" : "files.errors.notFound", { name: row?.name ?? "" });
    }
    return unique.map((id) => byId.get(id)!);
  });
}

/** A message part pointing at a stored file. */
export const filePart = (file: StoredFile): FileUIPart => ({
  type: "file",
  url: fileUrl(file.id),
  mediaType: file.mimeType,
  filename: file.name,
});

/**
 * Makes the files of a user message the conversation's: every file part must point at a pending
 * upload (or one the conversation already has). The parts are rewritten from the stored rows, so a
 * client cannot rename or retype a file. Data URLs and other sites' files are refused.
 */
export async function claimMessageFiles<M extends UIMessage>(message: M, conversationId: string): Promise<M> {
  const ids: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "file") continue;
    const id = fileIdFromUrl(part.url);
    if (!id) throw new UserError("files.errors.notAttachable", { name: part.filename ?? "" });
    ids.push(id);
  }
  if (!ids.length) return message;
  const byId = new Map((await claimFiles(ids, { conversationId })).map((f) => [f.id, f]));
  return {
    ...message,
    parts: message.parts.map((part) => (part.type === "file" ? filePart(byId.get(fileIdFromUrl(part.url)!)!) : part)),
  };
}

/** Deletes one file with its bytes; returns the deleted row, or null when there was none. */
export async function deleteFile(id: string): Promise<StoredFile | null> {
  const [row] = await db.delete(files).where(eq(files.id, id)).returning();
  if (row) await removeFileBytes([row.id]);
  return row ?? null;
}

/** Ids of the files these owners have; read them before deleting the owners to remove the bytes after. */
export async function fileIdsOwnedBy(owners: {
  conversationIds?: string[];
  taskIds?: string[];
  knowledgeItemIds?: string[];
}): Promise<string[]> {
  const conditions: SQL[] = [];
  if (owners.conversationIds?.length) conditions.push(inArray(files.conversationId, owners.conversationIds));
  if (owners.taskIds?.length) conditions.push(inArray(files.taskId, owners.taskIds));
  if (owners.knowledgeItemIds?.length) conditions.push(inArray(files.knowledgeItemId, owners.knowledgeItemIds));
  if (!conditions.length) return [];
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(or(...conditions));
  return rows.map((r) => r.id);
}

/** Removes the bytes of files whose rows are gone (deleted with their owner). */
export async function removeFileBytes(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => rm(filePath(id), { force: true })));
}

/**
 * Removes pending uploads nobody claimed within a day, and bytes on disk whose row is gone (an owner
 * deleted without `removeFileBytes`, or a save that failed halfway). Returns how many files went.
 */
export async function sweepFiles(): Promise<{ pending: number; orphaned: number }> {
  const now = Date.now();
  const pending = await db
    .delete(files)
    .where(and(unowned(), lt(files.createdAt, new Date(now - PENDING_MAX_AGE_MS))))
    .returning({ id: files.id });
  await removeFileBytes(pending.map((r) => r.id));

  const dir = resolveUpload(FILES_DIR);
  const names = dir ? await readdir(dir).catch(() => [] as string[]) : [];
  let orphaned = 0;
  for (let i = 0; i < names.length; i += 500) {
    const batch = names.slice(i, i + 500).filter((n) => /^[0-9a-f-]{36}$/.test(n));
    if (!batch.length) continue;
    const known = new Set((await db.select({ id: files.id }).from(files).where(inArray(files.id, batch))).map((r) => r.id));
    for (const name of batch) {
      if (known.has(name)) continue;
      const info = await stat(filePath(name)).catch(() => null);
      if (!info || now - info.mtimeMs < ORPHAN_GRACE_MS) continue;
      await rm(filePath(name), { force: true });
      orphaned += 1;
    }
  }
  return { pending: pending.length, orphaned };
}

import { db, files, knowledgeChunks, knowledgeItems } from "@abotica/db";
import { and, cosineDistance, desc, eq, inArray, isNotNull, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { isTextFile } from "../files/file-types";
import { claimFiles, getFile, readFileBytes, removeFileBytes } from "../files/files";
import { embedDocuments, embedQuery } from "./memory";
import { orTsQuery } from "./memory-ranking";
import { nearestFirst } from "./memory-search";
import { projectProviderPolicy, projectsProviderPolicy } from "../models/provider-policy";
import { readTextCapped, SafeFetchError, safeFetch } from "../platform/safe-fetch";

/** Longest text stored for one knowledge item. */
const MAX_KNOWLEDGE_CHARS = 200_000;

type KnowledgeKind = (typeof knowledgeItems.$inferSelect)["kind"];

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** Readable text of an HTML page: scripts, styles and markup removed, block breaks kept. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|header|footer|ul|ol|table)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? decodeEntities(match[1]!).replace(/\s+/g, " ").trim() : "";
  return title || null;
}

/** Most of a page's bytes are markup; this leaves room for well over MAX_KNOWLEDGE_CHARS of text. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

const refusalKeys = {
  protocol: "projects.errors.httpOnly",
  credentials: "memory.errors.credentialsInUrl",
  blocked: "memory.errors.blockedAddress",
  redirects: "memory.errors.tooManyRedirects",
} as const;

const fetchFailure = (error: unknown) =>
  error instanceof Error && error.name === "TimeoutError"
    ? new UserError("projects.errors.fetchTimeout")
    : new UserError("projects.errors.fetchFailed", { reason: (error as Error).message });

/**
 * Downloads a text page for the knowledge base, from public addresses only (see safeFetch). A page
 * larger than the cap is kept up to it. Errors are UserErrors with a readable reason.
 */
export async function fetchPageText(url: string): Promise<{ url: string; title: string; content: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError("projects.validation.invalidUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new UserError("projects.errors.httpOnly");
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(parsed, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Abotica/1.0)", accept: "text/html,text/plain,*/*" },
    });
  } catch (error) {
    if (error instanceof SafeFetchError) throw new UserError(refusalKeys[error.code], { host: error.host });
    throw fetchFailure(error);
  }
  const type = res.headers.get("content-type") ?? "";
  const readable = /text\/|json|xml/.test(type);
  // Frees the connection when the body is not read.
  if (!res.ok || !readable) void res.body?.cancel().catch(() => {});
  if (!res.ok) throw new UserError("projects.errors.httpStatus", { status: res.status });
  if (!readable) {
    throw type
      ? new UserError("projects.errors.unsupportedContentType", { type })
      : new UserError("projects.errors.unknownContentType");
  }
  let body: string;
  try {
    ({ text: body } = await readTextCapped(res, MAX_PAGE_BYTES));
  } catch (error) {
    throw fetchFailure(error);
  }
  const isHtml = type.includes("html") || /<html[\s>]/i.test(body.slice(0, 2_000));
  const content = isHtml ? htmlToText(body) : body;
  if (!content.trim()) throw new UserError("projects.errors.emptyPage");
  const title = (isHtml && htmlTitle(body)) || parsed.hostname + parsed.pathname;
  return { url: parsed.toString(), title: title.slice(0, 200), content };
}

const CHUNK_SIZE = 1_500;
const CHUNK_OVERLAP = 200;

function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= CHUNK_SIZE) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf("\n\n", end);
      if (breakAt > start + CHUNK_SIZE / 2) end = breakAt;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
}

/** (Re)indexes a knowledge item into searchable chunks. */
export async function indexKnowledgeItem(itemId: string): Promise<number> {
  const [item] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, itemId));
  if (!item) throw new Error(`Knowledge item ${itemId} not found`);
  const chunks = chunkText(`${item.title}\n\n${item.content}`);
  const vectors = await embedDocuments(chunks, await projectProviderPolicy(item.projectId));
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.itemId, itemId));
    if (chunks.length) {
      await tx.insert(knowledgeChunks).values(
        chunks.map((content, position) => ({
          itemId,
          projectId: item.projectId,
          position,
          content,
          embedding: vectors[position] ?? null,
        })),
      );
    }
  });
  return chunks.length;
}

/**
 * Romanian letters with diacritics (the comma and the cedilla forms of s and t) and their bare forms:
 * agents often type without them. The unaccent extension is not installed, so both the query and the
 * searched text fold these.
 */
const DIACRITICS = "ăâîșțşţ";
const BARE = "aaistst";

/** Lowercase text with DIACRITICS replaced by their bare letters. */
const foldDiacritics = (text: string) => text.replace(/[ăâîșțşţ]/gu, (letter) => BARE[DIACRITICS.indexOf(letter)]!);

/**
 * The keyword search's tsquery, for `to_tsquery('simple', ...)`: any topic word of the query (as memory
 * search builds it, see orTsQuery), folded like the searched text. Null when no word carries a topic.
 */
export function knowledgeTsQuery(query: string): string | null {
  const words = orTsQuery(query);
  return words && foldDiacritics(words);
}

/**
 * The query is embedded only when every searched project allows the embedding provider: a query may
 * carry a project's data, and a project that does not allow it has no embeddings to match anyway.
 * Without an embedding the chunks that hold any of the query's topic words, in their item's title or
 * their own text, come first by keyword rank, as in memory search: a query needs only some of its words.
 */
export async function searchKnowledge(query: string, projectIds: string[], limit = 6) {
  if (!projectIds.length) return [];
  const vector = await embedQuery(query, await projectsProviderPolicy(projectIds));
  const columns = { title: knowledgeItems.title, sourceUrl: knowledgeItems.sourceUrl, content: knowledgeChunks.content };
  if (vector) {
    const distance = cosineDistance(knowledgeChunks.embedding, vector);
    const found = await nearestFirst((tx) =>
      tx
        .select({ row: columns, distance: sql<number>`${distance}` })
        .from(knowledgeChunks)
        .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChunks.itemId))
        .where(and(inArray(knowledgeChunks.projectId, projectIds), isNotNull(knowledgeChunks.embedding)))
        .orderBy(distance)
        .limit(limit),
    );
    return found.map((r) => r.row);
  }
  const words = knowledgeTsQuery(query);
  if (!words) return [];
  // Computed per search: the chunks of the searched projects are few, so no stored column or index.
  const text = sql`to_tsvector('simple', translate(lower(${knowledgeItems.title} || ' ' || ${knowledgeChunks.content}), ${DIACRITICS}, ${BARE}))`;
  const tsQuery = sql`to_tsquery('simple', ${words})`;
  // Unlabelled positions count 1, not the default 0.1, as in memory search: one matched word ranks 1.
  const rank = sql<number>`ts_rank_cd('{1,1,1,1}', ${text}, ${tsQuery})`;
  return db
    .select(columns)
    .from(knowledgeChunks)
    .innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeChunks.itemId))
    .where(and(inArray(knowledgeChunks.projectId, projectIds), sql`${text} @@ ${tsQuery}`))
    .orderBy(desc(rank), knowledgeChunks.itemId, knowledgeChunks.position)
    .limit(limit);
}

/** Stores a knowledge item and indexes it for search; returns the number of chunks. */
export async function addKnowledgeItem(item: {
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  sourceUrl?: string | null;
  content: string;
}): Promise<{ id: string; chunks: number }> {
  const [row] = await db
    .insert(knowledgeItems)
    .values({ ...item, content: item.content.slice(0, MAX_KNOWLEDGE_CHARS) })
    .returning({ id: knowledgeItems.id });
  return { id: row!.id, chunks: await indexKnowledgeItem(row!.id) };
}

/**
 * Makes a pending upload a knowledge file of the project: a knowledge item titled with the file name
 * claims it. Text files are indexed for search; other files (PDF, images) are kept with no text and
 * reach agents only as files in the project workspace's knowledge folder.
 */
export async function addKnowledgeFile(input: {
  projectId: string;
  fileId: string;
}): Promise<{ id: string; chunks: number }> {
  const file = await getFile(input.fileId);
  if (!file) throw new UserError("files.errors.notFound");
  const text = isTextFile(file.mimeType, file.name);
  // A character takes at most 4 bytes in UTF-8: nothing past the stored length is read.
  const data = text ? await readFileBytes(file.id, MAX_KNOWLEDGE_CHARS * 4) : null;
  if (text && !data) throw new UserError("files.errors.missingOnDisk");
  const decoded = data ? new TextDecoder().decode(data).replace(/\0/g, "") : "";
  // Pages are indexed by their readable text, as links are, not by their markup.
  const content = (file.mimeType === "text/html" ? htmlToText(decoded) : decoded).slice(0, MAX_KNOWLEDGE_CHARS);
  const [row] = await db
    .insert(knowledgeItems)
    .values({ projectId: input.projectId, kind: "file", title: file.name, content })
    .returning({ id: knowledgeItems.id });
  const id = row!.id;
  try {
    await claimFiles([file.id], { knowledgeItemId: id });
  } catch (error) {
    // Not a pending upload (or already taken): the item would have no file.
    await db.delete(knowledgeItems).where(eq(knowledgeItems.id, id));
    throw error;
  }
  return { id, chunks: content ? await indexKnowledgeItem(id) : 0 };
}

/** Deletes a knowledge item of the project with its chunks and files; false when there was none. */
export async function deleteKnowledgeItem(input: { projectId: string; id: string }): Promise<boolean> {
  const owned = await db.select({ id: files.id }).from(files).where(eq(files.knowledgeItemId, input.id));
  const [row] = await db
    .delete(knowledgeItems)
    .where(and(eq(knowledgeItems.id, input.id), eq(knowledgeItems.projectId, input.projectId)))
    .returning({ id: knowledgeItems.id });
  if (!row) return false;
  await removeFileBytes(owned.map((f) => f.id));
  return true;
}

import { EMBEDDING_DIMENSIONS, db, journals, memories, type ModelRef, type Tx } from "@abotica/db";
import { embed, embedMany } from "ai";
import {
  and,
  cosineDistance,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { restatesFact } from "./memory-facts";
import {
  ANY_PROVIDER,
  projectProviderPolicy,
  projectsClosedTo,
  providerAllowed,
  type ProviderPolicy,
} from "../models/provider-policy";
import { embeddingModel, embeddingProvider } from "../models/providers";

export type Memory = typeof memories.$inferSelect;
export type MemoryScope = Memory["scope"];

const providerOptions = { openai: { dimensions: EMBEDDING_DIMENSIONS } };

/**
 * `policy` is the provider policy of the data the text carries (ANY_PROVIDER outside projects). Returns
 * null when the embedding provider is not allowed for it or not reachable; callers fall back to text search.
 */
export async function embedText(text: string, policy: ProviderPolicy): Promise<number[] | null> {
  if (!providerAllowed(policy, embeddingProvider())) return null;
  try {
    const { model } = await embeddingModel();
    const { embedding } = await embed({ model, value: text, providerOptions });
    return embedding;
  } catch (error) {
    console.warn("[memory] embedding unavailable:", (error as Error).message);
    return null;
  }
}

export async function embedTexts(texts: string[], policy: ProviderPolicy): Promise<(number[] | null)[]> {
  if (!texts.length) return [];
  if (!providerAllowed(policy, embeddingProvider())) return texts.map(() => null);
  try {
    const { model } = await embeddingModel();
    const { embeddings } = await embedMany({ model, values: texts, providerOptions });
    return embeddings;
  } catch (error) {
    console.warn("[memory] embedding unavailable:", (error as Error).message);
    return texts.map(() => null);
  }
}

/**
 * Runs a filtered nearest-neighbour search. An HNSW index hands the WHERE filter only ef_search
 * candidates (40 by default), so the rows of a small project or agent among many could all be missed;
 * pgvector's iterative scan keeps reading the index until the LIMIT is met. Relaxed order may return
 * rows slightly out of distance order, so they are sorted again here.
 */
export async function nearestFirst<T>(
  search: (tx: Tx) => Promise<{ row: T; distance: number }[]>,
): Promise<{ row: T; distance: number }[]> {
  const found = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return search(tx);
  });
  return found.sort((a, b) => Number(a.distance) - Number(b.distance));
}

/** Project memory is the project's data; global and agent memory are not tied to one. */
const memoryPolicy = (memory: { scope: MemoryScope; projectId?: string | null }) =>
  memory.scope === "project" ? projectProviderPolicy(memory.projectId ?? null) : Promise.resolve(ANY_PROVIDER);

/** For scope "project", `agentId` is the author (null: the user); for scope "agent", the owner. */
export async function remember(input: {
  scope: MemoryScope;
  content: string;
  projectId?: string | null;
  agentId?: string | null;
  source?: string;
  status?: Memory["status"];
}): Promise<Memory> {
  return insertMemory(input, await embedText(input.content, await memoryPolicy(input)));
}

async function insertMemory(input: Parameters<typeof remember>[0], embedding: number[] | null): Promise<Memory> {
  if (input.scope === "project" && !input.projectId) throw new Error("Project memory needs a projectId");
  if (input.scope === "agent" && !input.agentId) throw new Error("Agent memory needs an agentId");
  const [row] = await db
    .insert(memories)
    .values({
      scope: input.scope,
      content: input.content,
      projectId: input.scope === "project" ? input.projectId : null,
      agentId: input.scope === "global" ? null : (input.agentId ?? null),
      source: input.source ?? "manual",
      status: input.status ?? "active",
      embedding,
    })
    .returning();
  return row!;
}

/** Cosine distance under which two entries state the same fact. */
const SAME_FACT_DISTANCE = 0.15;

/**
 * `remember` for facts extracted by consolidation, which keep restating what memory already holds.
 * A fact close to an existing entry of the same project or agent memory adds nothing: it rewords an
 * earlier consolidated entry (newer beats older) and leaves an entry a user or an agent wrote as is.
 * Without an embedding (the project does not allow the embedding provider, or it is unreachable), a
 * fact is the same when its text is (see restatesFact).
 */
export async function rememberFact(input: {
  scope: "project" | "agent";
  content: string;
  projectId?: string | null;
  agentId: string;
}): Promise<void> {
  const sameMemory = and(
    eq(memories.scope, input.scope),
    input.scope === "project" ? eq(memories.projectId, input.projectId ?? "") : eq(memories.agentId, input.agentId),
  );
  const embedding = await embedText(input.content, await memoryPolicy(input));
  if (embedding) {
    const distance = cosineDistance(memories.embedding, embedding);
    const [closest] = await nearestFirst((tx) =>
      tx
        .select({ row: { id: memories.id, source: memories.source }, distance: sql<number>`${distance}` })
        .from(memories)
        .where(and(sameMemory, isNotNull(memories.embedding)))
        .orderBy(distance)
        .limit(1),
    );
    if (closest && Number(closest.distance) < SAME_FACT_DISTANCE) {
      if (closest.row.source === "consolidation") {
        await db.update(memories).set({ content: input.content, embedding }).where(eq(memories.id, closest.row.id));
      }
      return;
    }
  } else {
    const existing = await db.select({ content: memories.content }).from(memories).where(sameMemory);
    const contents = existing.map((m) => m.content);
    if (restatesFact(input.content, contents)) return;
  }
  await insertMemory({ ...input, source: "consolidation" }, embedding);
}

/**
 * Who a memory write is for: an agent's page, a project's page, or none for the memory page.
 * With an owner, entries of other agents or projects are refused as not found.
 */
export type MemoryOwner = { agentId: string } | { projectId: string };

type MemoryWriteOptions = { owner?: MemoryOwner; actor?: string; data?: Record<string, unknown> };

function ownedBy(owner: MemoryOwner | undefined) {
  if (!owner) return undefined;
  return "agentId" in owner
    ? and(eq(memories.scope, "agent"), eq(memories.agentId, owner.agentId))
    : and(eq(memories.scope, "project"), eq(memories.projectId, owner.projectId));
}

/** Throws unless every id exists and belongs to the owner. */
async function ownedMemories(ids: string[], owner: MemoryOwner | undefined): Promise<Memory[]> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select()
    .from(memories)
    .where(and(inArray(memories.id, unique), ownedBy(owner)));
  if (rows.length !== unique.length) throw new UserError("projects.errors.memoryNotFound");
  return rows;
}

const auditData = (memory: Pick<Memory, "scope" | "agentId" | "projectId">, extra?: Record<string, unknown>) => ({
  scope: memory.scope,
  ...(memory.agentId && { agentId: memory.agentId }),
  ...(memory.projectId && { projectId: memory.projectId }),
  ...extra,
});

/** `remember` plus the audit entry, for writes a user or an agent makes on purpose. */
export async function createMemory(
  input: Parameters<typeof remember>[0],
  opts: Pick<MemoryWriteOptions, "actor" | "data"> = {},
): Promise<Memory> {
  const row = await remember(input);
  await audit({
    actor: opts.actor ?? "user",
    action: "memory.created",
    entityType: "memory",
    entityId: row.id,
    data: auditData(row, opts.data),
  });
  return row;
}

/** `status` sends an edited entry back for approval when agents' writes need it. */
export async function updateMemory(
  id: string,
  content: string,
  opts: MemoryWriteOptions & { status?: Memory["status"] } = {},
): Promise<void> {
  const [memory] = await ownedMemories([id], opts.owner);
  const embedding = await embedText(content, await memoryPolicy(memory!));
  await db
    .update(memories)
    .set({ content, embedding, ...(opts.status && { status: opts.status }) })
    .where(eq(memories.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: "memory.updated",
    entityType: "memory",
    entityId: id,
    data: auditData(memory!, opts.data),
  });
}

export async function deleteMemory(id: string, opts: MemoryWriteOptions = {}): Promise<void> {
  const [memory] = await ownedMemories([id], opts.owner);
  await db.delete(memories).where(eq(memories.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: "memory.deleted",
    entityType: "memory",
    entityId: id,
    data: auditData(memory!, opts.data),
  });
}

/** Activates pending entries; returns the ids that changed. Entries already active are skipped. */
export async function approveMemories(ids: string[], opts: MemoryWriteOptions = {}): Promise<string[]> {
  if (opts.owner) await ownedMemories(ids, opts.owner);
  const rows = await db
    .update(memories)
    .set({ status: "active" })
    .where(and(inArray(memories.id, ids), eq(memories.status, "pending")))
    .returning({ id: memories.id });
  return reviewed("memory.approved", rows, opts);
}

/** Deletes pending entries; returns the ids removed. Active entries are left alone. */
export async function rejectMemories(ids: string[], opts: MemoryWriteOptions = {}): Promise<string[]> {
  if (opts.owner) await ownedMemories(ids, opts.owner);
  const rows = await db
    .delete(memories)
    .where(and(inArray(memories.id, ids), eq(memories.status, "pending")))
    .returning({ id: memories.id });
  return reviewed("memory.rejected", rows, opts);
}

async function reviewed(
  action: "memory.approved" | "memory.rejected",
  rows: { id: string }[],
  opts: MemoryWriteOptions,
): Promise<string[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await audit({
      actor: opts.actor ?? "user",
      action,
      entityType: "memory",
      entityId: ids.length === 1 ? ids[0] : null,
      data: { ids, ...opts.owner, ...opts.data },
    });
  }
  return ids;
}

/** The memory of each scope a run may read: global, the agent's own, and its project's (if any). */
function visibleScopes(agentId: string, projectId: string | null) {
  return {
    global: eq(memories.scope, "global"),
    agent: and(eq(memories.scope, "agent"), eq(memories.agentId, agentId)),
    project: projectId ? and(eq(memories.scope, "project"), eq(memories.projectId, projectId)) : undefined,
  };
}

/** Memories a run may read (see memoryVisibleTo). */
function visibleTo(agentId: string, projectId: string | null) {
  const scopes = visibleScopes(agentId, projectId);
  return and(eq(memories.status, "active"), or(scopes.global, scopes.agent, scopes.project));
}

const memoryColumns = {
  id: memories.id,
  scope: memories.scope,
  content: memories.content,
  updatedAt: memories.updatedAt,
};

/**
 * Baseline memory injected in every run: the most recent entries of each scope, each with its own
 * limit so that a busy scope does not crowd out the others.
 */
export async function contextMemories(agentId: string, projectId: string | null, perScope = 40) {
  const scopes = visibleScopes(agentId, projectId);
  const newest = (scope: ReturnType<typeof and>) =>
    db
      .select(memoryColumns)
      .from(memories)
      .where(and(eq(memories.status, "active"), scope))
      .orderBy(desc(memories.updatedAt))
      .limit(perScope);
  const [project, agent, global] = await Promise.all([
    scopes.project ? newest(scopes.project) : [],
    newest(scopes.agent),
    newest(scopes.global),
  ]);
  return { global, project, agent };
}

export async function searchMemories(query: string, opts: { agentId: string; projectId: string | null; limit?: number }) {
  const limit = opts.limit ?? 8;
  // A query made inside a project may carry its data.
  const vector = await embedText(query, await projectProviderPolicy(opts.projectId));
  if (vector) {
    const distance = cosineDistance(memories.embedding, vector);
    const found = await nearestFirst((tx) =>
      tx
        .select({ row: memoryColumns, distance: sql<number>`${distance}` })
        .from(memories)
        .where(and(visibleTo(opts.agentId, opts.projectId), isNotNull(memories.embedding)))
        .orderBy(distance)
        .limit(limit),
    );
    return found.map((r) => r.row);
  }
  return db
    .select(memoryColumns)
    .from(memories)
    .where(and(visibleTo(opts.agentId, opts.projectId), ilike(memories.content, `%${query}%`)))
    .orderBy(desc(memories.updatedAt))
    .limit(limit);
}

/** Journals of one project (null: the work outside projects); undefined matches every project. */
const journalProject = (projectId: string | null | undefined) =>
  projectId === undefined ? undefined : projectId ? eq(journals.projectId, projectId) : isNull(journals.projectId);

/** The agent's journals of the last days for the run's project only (null: outside projects). */
export async function recentJournals(agentId: string, projectId: string | null, days: number) {
  return db
    .select({ day: journals.day, summary: journals.summary })
    .from(journals)
    .where(
      and(eq(journals.agentId, agentId), journalProject(projectId), gte(journals.day, sql`current_date - ${days}::int`)),
    )
    .orderBy(desc(journals.day));
}

/**
 * `projectId` narrows to one project's journals, null to the ones outside projects. `readableBy` is the
 * model chain the results go to: journals of projects that do not allow all of it are left out.
 */
export async function searchJournals(
  query: string,
  opts: { agentId?: string; projectId?: string | null; limit?: number; readableBy?: ModelRef[] } = {},
) {
  const vector = await embedText(query, await projectProviderPolicy(opts.projectId ?? null));
  const closed = opts.readableBy ? [...(await projectsClosedTo(opts.readableBy))] : [];
  const scope = and(
    opts.agentId ? eq(journals.agentId, opts.agentId) : undefined,
    journalProject(opts.projectId),
    closed.length ? or(isNull(journals.projectId), notInArray(journals.projectId, closed)) : undefined,
  );
  const columns = {
    agentId: journals.agentId,
    projectId: journals.projectId,
    day: journals.day,
    summary: journals.summary,
  };
  if (vector) {
    const distance = cosineDistance(journals.embedding, vector);
    const found = await nearestFirst((tx) =>
      tx
        .select({ row: columns, distance: sql<number>`${distance}` })
        .from(journals)
        .where(and(scope, isNotNull(journals.embedding)))
        .orderBy(distance)
        .limit(opts.limit ?? 5),
    );
    return found.map((r) => r.row);
  }
  return db
    .select(columns)
    .from(journals)
    .where(and(scope, ilike(journals.summary, `%${query}%`)))
    .orderBy(desc(journals.day))
    .limit(opts.limit ?? 5);
}

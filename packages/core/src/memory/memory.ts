import { EMBEDDING_DIMENSIONS, db, journals, memories, type ModelRef } from "@abotica/db";
import { embed, embedMany } from "ai";
import { and, desc, eq, gt, gte, inArray, isNull, ne, notInArray, or, sql, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import {
  CONFLICTS_WITH_OWNER,
  CONSOLIDATION_CANDIDATES,
  type ConsolidatedFact,
  expiryFor,
  invalidationTime,
  keepsHistory,
  planFact,
  type RelatedEntry,
} from "./memory-consolidation";
import { hybridSearchJournals, hybridSearchMemories } from "./memory-search";
import {
  checkMemoryWrite,
  type CheckedWrite,
  heldBecause,
  MemorySecretError,
  sameMemory,
  similarMemories,
  type SimilarMemory,
} from "./memory-write-gate";
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
 * null when the embedding provider is not allowed for it or not reachable; search is then by keyword only.
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

/** Project memory is the project's data; global and agent memory are not tied to one. */
const memoryPolicy = (memory: { scope: MemoryScope; projectId?: string | null }) =>
  memory.scope === "project" ? projectProviderPolicy(memory.projectId ?? null) : Promise.resolve(ANY_PROVIDER);

/**
 * For scope "project", `agentId` is the author (null: the user); for scope "agent", the owner.
 * `origin` is whose content it is (see memoryOrigin), `source` how it was written.
 */
export type MemoryInput = {
  scope: MemoryScope;
  content: string;
  projectId?: string | null;
  agentId?: string | null;
  source?: string;
  origin: Memory["origin"];
  status?: Memory["status"];
  /** How long the fact holds; by default permanent for the user's own entries, durable for the rest. */
  retention?: Memory["retention"];
  /** The day the fact became true (YYYY-MM-DD); null: the day it is stored. */
  validFrom?: string | null;
  pinned?: boolean;
};

/** Secret values the caller knows beyond the vault's, which a write must not store (a run's repository tokens). */
type KnownSecrets = { knownSecrets?: readonly string[] };

/** Throws MemorySecretError when the content holds a secret (see memory-write-gate.ts). */
export async function remember(input: MemoryInput, opts: KnownSecrets = {}): Promise<Memory> {
  const checked = await checkInput(input, opts);
  return insertMemory(input, checked, await embedText(checked.content, await memoryPolicy(input)));
}

const checkInput = (input: MemoryInput, opts: KnownSecrets) =>
  checkMemoryWrite(input.content, {
    origin: input.origin,
    status: input.status ?? "active",
    knownSecrets: opts.knownSecrets,
  });

/** A checked write as stored; `flagReason` may also be a reason of the caller's (CONFLICTS_WITH_OWNER). */
type StoredWrite = Pick<CheckedWrite, "content" | "status"> & { flagReason: string | null };

async function insertMemory(input: MemoryInput, checked: StoredWrite, embedding: number[] | null): Promise<Memory> {
  if (input.scope === "project" && !input.projectId) throw new Error("Project memory needs a projectId");
  if (input.scope === "agent" && !input.agentId) throw new Error("Agent memory needs an agentId");
  const source = input.source ?? "manual";
  const retention = input.retention ?? (source === "manual" ? "permanent" : "durable");
  const validFrom = input.validFrom ?? null;
  const [row] = await db
    .insert(memories)
    .values({
      scope: input.scope,
      content: checked.content,
      projectId: input.scope === "project" ? input.projectId : null,
      agentId: input.scope === "global" ? null : (input.agentId ?? null),
      source,
      origin: input.origin,
      status: checked.status ?? "active",
      flagReason: checked.flagReason,
      embedding,
      retention,
      validFrom,
      expiresAt: expiryFor(retention, validFrom, new Date()),
      pinned: input.pinned ?? false,
    })
    .returning();
  return row!;
}

/** What storing a consolidated fact did. */
export type FactOutcome = "added" | "held" | "restated" | "dropped";

/** The memory consolidation writes to: a project's, written by the agent, or the agent's own. */
export type ConsolidationTarget =
  { scope: "project"; projectId: string; agentId: string } | { scope: "agent"; agentId: string };

/** A consolidated entry stated again: fresher in search and counted as used. Its text stays as it is. */
const refreshMemory = (id: string) =>
  db
    .update(memories)
    .set({ updatedAt: new Date(), recallCount: sql`${memories.recallCount} + 1` })
    .where(eq(memories.id, id));

/**
 * Stores a fact extracted by consolidation. `origin` is "untrusted" when a journal it came from had read
 * untrusted content: the fact then waits for approval. `replaces` are the entries it contradicts (see
 * replaceEntries); `conflictsWithOwner` holds it for approval, since an entry the user wrote is never
 * replaced without the user. A fact the same memory already holds (by embedding, or by text without one)
 * is not stored again and never rewords that entry: a trusted one refreshes a consolidated entry. A fact
 * holding a secret is dropped.
 */
export async function rememberFact(
  input: ConsolidationTarget & {
    content: string;
    origin: "system" | "untrusted";
    retention: Memory["retention"];
    validFrom: string | null;
    replaces?: string[];
    conflictsWithOwner?: boolean;
  },
): Promise<FactOutcome> {
  const { replaces = [], conflictsWithOwner = false, ...rest } = input;
  const fact: MemoryInput = { ...rest, source: "consolidation" };
  const checked = await checkInput(fact, {}).catch((error: unknown) => {
    if (!(error instanceof MemorySecretError)) throw error;
    console.warn(`[memory] consolidation dropped a fact holding ${error.reasons.join(", ")}`);
    return null;
  });
  if (!checked) return "dropped";
  const embedding = await embedText(checked.content, await memoryPolicy(input));
  // Only what agents read counts: replaced, expired and pending entries are not restated by a fact.
  const { duplicate } = await similarMemories(and(sameMemory(input), current()), checked.content, embedding);
  if (duplicate) {
    if (duplicate.source === "consolidation" && checked.status === "active") await refreshMemory(duplicate.id);
    return "restated";
  }
  const write: StoredWrite = conflictsWithOwner
    ? { ...checked, status: "pending", flagReason: checked.flagReason ?? CONFLICTS_WITH_OWNER }
    : checked;
  const row = await insertMemory(fact, write, embedding);
  await replaceEntries(row, replaces, "system");
  return row.status === "active" ? "added" : "held";
}

/**
 * Applies consolidation's facts (see planFact) to a project's or an agent's memory. `related` are the
 * entries its prompt showed, in the order of their integer ids (see consolidationCandidates).
 */
export async function applyConsolidation(
  target: ConsolidationTarget,
  facts: readonly ConsolidatedFact[],
  related: readonly RelatedEntry[],
  origin: "system" | "untrusted",
): Promise<Record<FactOutcome, number>> {
  const counts: Record<FactOutcome, number> = { added: 0, held: 0, restated: 0, dropped: 0 };
  for (const fact of facts) {
    const plan = planFact(fact, related, origin);
    if (plan.kind === "restated") {
      if (plan.refresh) await refreshMemory(plan.entryId);
      counts.restated++;
      continue;
    }
    const outcome = await rememberFact({
      ...target,
      content: fact.content,
      origin,
      retention: fact.retention,
      validFrom: fact.validFrom,
      replaces: plan.replaces,
      conflictsWithOwner: plan.conflictsWithOwner,
    });
    counts[outcome]++;
  }
  return counts;
}

/**
 * The current entries of the memory consolidation writes to that are closest to its journals, for the
 * model to compare its facts with: a hybrid search per journal (with the embedding the journal already
 * has), taken in turns so each journal's nearest entries are in.
 */
export async function consolidationCandidates(
  target: ConsolidationTarget,
  journalRows: readonly { summary: string; embedding: number[] | null }[],
) {
  const where = and(sameMemory(target), current());
  const found = await Promise.all(
    journalRows.map((j) =>
      hybridSearchMemories(j.summary, { vector: j.embedding, where, limit: CONSOLIDATION_CANDIDATES }),
    ),
  );
  const picked = new Map<string, (typeof found)[number][number]>();
  for (let rank = 0; found.some((rows) => rank < rows.length); rank++) {
    for (const row of found.flatMap((rows) => rows[rank] ?? [])) {
      if (picked.size < CONSOLIDATION_CANDIDATES && !picked.has(row.id)) picked.set(row.id, row);
    }
  }
  return [...picked.values()];
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

async function auditCreated(row: Memory, opts: Pick<MemoryWriteOptions, "actor" | "data">): Promise<Memory> {
  await audit({
    actor: opts.actor ?? "user",
    action: "memory.created",
    entityType: "memory",
    entityId: row.id,
    data: auditData(row, { origin: row.origin, ...(row.flagReason && { flagReason: row.flagReason }), ...opts.data }),
  });
  return row;
}

/** `remember` plus the audit entry, for writes a user or an agent makes on purpose. */
export async function createMemory(
  input: MemoryInput,
  opts: Pick<MemoryWriteOptions, "actor" | "data"> & KnownSecrets = {},
): Promise<Memory> {
  return auditCreated(await remember(input, opts), opts);
}

/**
 * An agent's save (memory_save): `createMemory` that does not store a fact the same memory already
 * holds. A duplicate returns the entry it restates and stores nothing; otherwise the saved entry
 * comes with the entries it is related to, which it may replace, and why it waits for approval (if it
 * does). Throws MemorySecretError like `remember`.
 */
export async function saveMemory(
  input: MemoryInput,
  opts: Pick<MemoryWriteOptions, "actor" | "data"> & KnownSecrets = {},
): Promise<{ duplicateOf: SimilarMemory } | { memory: Memory; related: SimilarMemory[]; heldBecause: string | null }> {
  const checked = await checkInput(input, opts);
  const embedding = await embedText(checked.content, await memoryPolicy(input));
  // Only what agents read: the answer shows these entries to the agent.
  const { duplicate, related } = await similarMemories(and(sameMemory(input), current()), checked.content, embedding);
  if (duplicate) return { duplicateOf: duplicate };
  const memory = await auditCreated(await insertMemory(input, checked, embedding), opts);
  return { memory, related, heldBecause: heldBecause(checked, input.origin) };
}

/**
 * Replaces an entry's content, checked like a new write. `origin` is whose the new content is; left
 * out (the user's own edit), the entry keeps its origin and is not held. `status` sends an edited entry
 * back for approval when agents' writes need it; untrusted or flagged content always goes back.
 * An agent's edit of an active entry agents wrote (see keepsHistory) keeps the old text: a new entry
 * written by `agentId` replaces it (see replaceEntries) and its id is returned. Returns why the entry now
 * waits for approval, null when it does not.
 */
export async function updateMemory(
  id: string,
  content: string,
  opts: MemoryWriteOptions &
    KnownSecrets & {
      status?: Memory["status"];
      origin?: Memory["origin"];
      retention?: Memory["retention"];
      agentId?: string;
    } = {},
): Promise<{ id: string; heldBecause: string | null }> {
  const [memory] = await ownedMemories([id], opts.owner);
  const origin = opts.origin ?? "owner";
  const checked = await checkMemoryWrite(content, { origin, status: opts.status, knownSecrets: opts.knownSecrets });
  const embedding = await embedText(checked.content, await memoryPolicy(memory!));
  const actor = opts.actor ?? "user";
  if (opts.origin && memory!.status === "active" && keepsHistory(memory!.origin)) {
    const row = await insertMemory(
      {
        scope: memory!.scope,
        content: checked.content,
        projectId: memory!.projectId,
        // A project entry's author is who wrote this version; an agent entry stays its owner's.
        agentId: memory!.scope === "project" ? (opts.agentId ?? null) : memory!.agentId,
        source: "agent",
        origin: opts.origin,
        retention: opts.retention ?? memory!.retention,
        pinned: memory!.pinned,
      },
      checked,
      embedding,
    );
    await audit({
      actor,
      action: "memory.updated",
      entityType: "memory",
      entityId: row.id,
      data: auditData(row, { origin: opts.origin, replaces: id, ...opts.data }),
    });
    await replaceEntries(row, [id], actor);
    return { id: row.id, heldBecause: heldBecause(checked, origin) };
  }
  await db
    .update(memories)
    .set({
      content: checked.content,
      embedding,
      flagReason: checked.flagReason,
      ...(opts.origin && { origin: opts.origin }),
      ...(checked.status && { status: checked.status }),
      ...(opts.retention && {
        retention: opts.retention,
        expiresAt: expiryFor(opts.retention, memory!.validFrom, new Date()),
      }),
    })
    .where(eq(memories.id, id));
  await audit({
    actor,
    action: "memory.updated",
    entityType: "memory",
    entityId: id,
    data: auditData(memory!, { ...(opts.origin && { origin: opts.origin }), ...opts.data }),
  });
  return { id, heldBecause: heldBecause(checked, origin) };
}

/**
 * Makes `replacement` the newer version of the entries `ids`. An active replacement invalidates them at
 * once: agents stop seeing them and the memory page keeps them as history. One that waits for approval
 * only points them to it: approving it invalidates them (approveMemories), rejecting it deletes it and
 * leaves them as they were.
 */
async function replaceEntries(replacement: Pick<Memory, "id" | "status" | "validFrom">, ids: string[], actor: string) {
  if (!ids.length) return;
  if (replacement.status === "active") return invalidate(replacement, inArray(memories.id, ids), actor);
  await db
    .update(memories)
    .set({ supersededBy: replacement.id, updatedAt: sql`${memories.updatedAt}` })
    .where(and(inArray(memories.id, ids), isNull(memories.invalidatedAt)));
}

/**
 * Invalidates the current entries `which` selects in favour of `replacement`, from the day it became true.
 * History, not an edit: `updatedAt` stays.
 */
async function invalidate(replacement: Pick<Memory, "id" | "validFrom">, which: SQL, actor: string): Promise<void> {
  const rows = await db
    .update(memories)
    .set({
      invalidatedAt: invalidationTime(replacement.validFrom, new Date()),
      supersededBy: replacement.id,
      updatedAt: sql`${memories.updatedAt}`,
    })
    .where(and(which, isNull(memories.invalidatedAt), ne(memories.id, replacement.id)))
    .returning({ id: memories.id, scope: memories.scope, agentId: memories.agentId, projectId: memories.projectId });
  for (const row of rows) {
    await audit({
      actor,
      action: "memory.invalidated",
      entityType: "memory",
      entityId: row.id,
      data: auditData(row, { supersededBy: replacement.id }),
    });
  }
}

/** Makes an entry a newer fact replaced current again; the entry that replaced it stays as it is. */
export async function restoreMemory(id: string, opts: MemoryWriteOptions = {}): Promise<void> {
  const [memory] = await ownedMemories([id], opts.owner);
  if (!memory!.invalidatedAt) return;
  await db
    .update(memories)
    .set({ invalidatedAt: null, supersededBy: null, updatedAt: sql`${memories.updatedAt}` })
    .where(eq(memories.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: "memory.restored",
    entityType: "memory",
    entityId: id,
    data: auditData(memory!, { ...(memory!.supersededBy && { supersededBy: memory!.supersededBy }), ...opts.data }),
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

/**
 * Pins or unpins an entry: pinned entries are in the system prompt of every run of their scope, within
 * the pinned budget (see pinnedMemories). Not an edit, so the entry keeps its `updatedAt` and its place.
 */
export async function setMemoryPinned(id: string, pinned: boolean, opts: MemoryWriteOptions = {}): Promise<void> {
  const [memory] = await ownedMemories([id], opts.owner);
  if (memory!.pinned === pinned) return;
  await db
    .update(memories)
    .set({ pinned, updatedAt: sql`${memories.updatedAt}` })
    .where(eq(memories.id, id));
  await audit({
    actor: opts.actor ?? "user",
    action: pinned ? "memory.pinned" : "memory.unpinned",
    entityType: "memory",
    entityId: id,
    data: auditData(memory!, opts.data),
  });
}

/**
 * Activates pending entries; returns the ids that changed. Entries already active are skipped. An entry
 * that replaces others replaces them now (see replaceEntries).
 */
export async function approveMemories(ids: string[], opts: MemoryWriteOptions = {}): Promise<string[]> {
  if (opts.owner) await ownedMemories(ids, opts.owner);
  const rows = await db
    .update(memories)
    .set({ status: "active" })
    .where(and(inArray(memories.id, ids), eq(memories.status, "pending")))
    .returning({ id: memories.id, validFrom: memories.validFrom });
  const approved = await reviewed("memory.approved", rows, opts);
  for (const row of rows) await invalidate(row, eq(memories.supersededBy, row.id), opts.actor ?? "user");
  return approved;
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

/** Entries agents read: approved, not replaced by a newer fact, and not expired. */
const current = () =>
  and(
    eq(memories.status, "active"),
    isNull(memories.invalidatedAt),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );

/** Memories a run may read (see memoryVisibleTo). */
function visibleTo(agentId: string, projectId: string | null) {
  const scopes = visibleScopes(agentId, projectId);
  return and(current(), or(scopes.global, scopes.agent, scopes.project));
}

/** For the memory a run gets in its prompt (memory-recall.ts). */
export { current as currentMemories, visibleTo as memoriesVisibleTo };

/** Hybrid search (see hybridSearchMemories) over the memories a run may read. */
export async function searchMemories(query: string, opts: { agentId: string; projectId: string | null; limit?: number }) {
  // A query made inside a project may carry its data.
  const vector = await embedText(query, await projectProviderPolicy(opts.projectId));
  const found = await hybridSearchMemories(query, {
    vector,
    where: visibleTo(opts.agentId, opts.projectId),
    limit: opts.limit ?? 8,
  });
  return found.map((m) => ({ id: m.id, scope: m.scope, content: m.content, updatedAt: m.updatedAt }));
}

/**
 * Hybrid search across every memory, all scopes, owners and statuses: the memory page. `mode` is
 * "keyword" when the query could not be embedded.
 */
export async function searchAllMemories(query: string, limit = 20) {
  // The user's own query, typed outside any project.
  const vector = await embedText(query, ANY_PROVIDER);
  const rows = await hybridSearchMemories(query, { vector, limit });
  return { mode: vector ? ("hybrid" as const) : ("keyword" as const), rows };
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
 * Hybrid search of journals (see hybridSearchJournals). `agentId` narrows to one agent's journals,
 * `projectId` to one project's, null to the ones outside projects. `readableBy` is the
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
  const found = await hybridSearchJournals(query, { vector, where: scope, limit: opts.limit ?? 5 });
  return found.map((j) => ({ agentId: j.agentId, projectId: j.projectId, day: j.day, summary: j.summary }));
}

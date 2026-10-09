import { db, journals, memories, type ModelRef } from "@abotica/db";
import { embed, embedMany } from "ai";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { getSettings } from "../settings/settings";
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
import { type MemoryReader, notesProject } from "./memory-scope";
import { hybridSearchJournals, hybridSearchMemories } from "./memory-search";
import {
  checkMemoryWrite,
  type CheckedWrite,
  heldBecause,
  MemorySecretError,
  namedProject,
  projectNamed,
  projectsOfAgent,
  sameMemory,
  similarMemories,
  type SimilarMemory,
} from "./memory-write-gate";
import {
  ANY_PROVIDER,
  embeddingAllowed,
  projectProviderPolicy,
  projectsClosedTo,
  type ProviderPolicy,
} from "../models/provider-policy";
import { type EmbedKind, embeddingInput } from "../models/embedding-profiles";
import { embedLocal } from "../models/local-embeddings";
import { embeddingProvider, ollamaEmbeddingModel } from "../models/providers";
import type { EmbeddingProvider } from "../settings/settings-schema";

export type Memory = typeof memories.$inferSelect;
export type MemoryScope = Memory["scope"];

/**
 * `policy` is the provider policy of the data the text carries (ANY_PROVIDER outside projects). Returns
 * null when the embedding provider is not allowed for it or not reachable; search is then by keyword only.
 */
async function embedOne(kind: EmbedKind, text: string, policy: ProviderPolicy): Promise<number[] | null> {
  const [vector] = await embedAll(kind, [text], policy);
  return vector ?? null;
}

async function embedAll(kind: EmbedKind, texts: string[], policy: ProviderPolicy): Promise<(number[] | null)[]> {
  if (!texts.length) return [];
  const provider = await embeddingProvider();
  if (!embeddingAllowed(policy, provider)) return texts.map(() => null);
  try {
    return await embedWith(provider, texts, kind);
  } catch (error) {
    console.warn("[memory] embedding unavailable:", (error as Error).message);
    return texts.map(() => null);
  }
}

/** A search query's vector (see embedOne); retrieval models embed a query apart from what it looks for. */
export const embedQuery = (query: string, policy: ProviderPolicy) => embedOne("query", query, policy);

/** The vector of a text that is stored and searched: a memory, a journal, a knowledge chunk (see embedOne). */
export const embedDocument = (text: string, policy: ProviderPolicy) => embedOne("document", text, policy);

export const embedDocuments = (texts: string[], policy: ProviderPolicy) => embedAll("document", texts, policy);

/**
 * Embeds with `provider`, throwing when it cannot (no key, server down, the built-in model still
 * loading): the re-embedding after a provider change waits and tries again, where a write goes on
 * without embeddings (embedDocuments). Each text gets the model's prompt for `kind`.
 */
export async function embedWith(provider: EmbeddingProvider, texts: string[], kind: EmbedKind): Promise<number[][]> {
  if (!texts.length) return [];
  const values = texts.map((text) => embeddingInput(provider, kind, text));
  if (provider === "local") return embedLocal(values);
  const model = await ollamaEmbeddingModel();
  if (values.length === 1) return [(await embed({ model, value: values[0]! })).embedding];
  const { embeddings } = await embedMany({ model, values });
  return embeddings;
}

/** Team memory and an agent's notes on a project are the project's data; global memory and craft are not tied to one. */
const memoryPolicy = (memory: { scope: MemoryScope; projectId?: string | null }) =>
  memory.scope !== "global" && memory.projectId ? projectProviderPolicy(memory.projectId) : Promise.resolve(ANY_PROVIDER);

/**
 * For scope "project" (team memory), `agentId` is the author (null: the user); for scope "agent", the
 * owner, and `projectId` the project of the agent's notes (null: its craft, read in every project).
 * `origin` is whose content it is (see memoryOrigin), `source` how it was written.
 */
type MemoryInput = {
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
  /** The agent run that writes it; null: the user or consolidation. */
  runId?: string | null;
};

/** Secret values the caller knows beyond the vault's, which a write must not store (a run's repository tokens). */
type KnownSecrets = { knownSecrets?: readonly string[] };

/** Throws MemorySecretError when the content holds a secret (see memory-write-gate.ts). */
export async function remember(input: MemoryInput, opts: KnownSecrets = {}): Promise<Memory> {
  const checked = await checkInput(input, opts);
  return insertMemory(input, checked, await embedDocument(checked.content, await memoryPolicy(input)));
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
      projectId: input.scope === "global" ? null : (input.projectId ?? null),
      agentId: input.scope === "global" ? null : (input.agentId ?? null),
      source,
      origin: input.origin,
      status: checked.status ?? "active",
      flagReason: checked.flagReason,
      embedding,
      retention,
      validFrom,
      expiresAt: expiryFor(retention, validFrom, new Date(), (await getSettings()).memory.ephemeralDays),
      pinned: input.pinned ?? false,
      runId: input.runId ?? null,
    })
    .returning();
  return row!;
}

/** What storing a consolidated fact did. */
type FactOutcome = "added" | "held" | "restated" | "dropped";

const noOutcomes = (): Record<FactOutcome, number> => ({ added: 0, held: 0, restated: 0, dropped: 0 });

/**
 * The memory consolidation writes to: always the agent's own, its notes on the journals' project or,
 * for journals outside projects (and craft lessons), its craft (null); a fact of those that names a project
 * goes to the notes on it (see applyConsolidationOutsideProjects). Team memory gets only explicit saves.
 */
export type ConsolidationTarget = { scope: "agent"; agentId: string; projectId: string | null };

/** A consolidated entry stated again: fresher in search and counted as used. Its text stays as it is. */
const refreshMemory = (id: string) =>
  db
    .update(memories)
    .set({ updatedAt: new Date(), recallCount: sql`${memories.recallCount} + 1` })
    .where(eq(memories.id, id));

/**
 * Stores a fact extracted by consolidation. `origin` is "untrusted" when a journal it came from had read
 * untrusted content: the fact is stored active unless the scan flags it or `memoryRequiresApproval` is on
 * (see decideMemoryWrite). `replaces` are the entries it contradicts (see replaceEntries);
 * `conflictsWithOwner` holds it for approval, since an entry the user wrote is never replaced without the
 * user. A fact the same memory already holds (by embedding, or by text without one) is not stored again
 * and never rewords that entry: a trusted one refreshes a consolidated entry. A fact for the agent's notes
 * on a project that the project's team memory already holds is not stored either. A fact holding a secret
 * is dropped.
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
  const held = input.origin === "untrusted" && (await getSettings()).memory.requiresApproval;
  const fact: MemoryInput = { ...rest, source: "consolidation", status: held ? "pending" : "active" };
  const checked = await checkInput(fact, {}).catch((error: unknown) => {
    if (!(error instanceof MemorySecretError)) throw error;
    console.warn(`[memory] consolidation dropped a fact holding ${error.reasons.join(", ")}`);
    return null;
  });
  if (!checked) return "dropped";
  const embedding = await embedDocument(checked.content, await memoryPolicy(input));
  // Only what agents read counts: replaced, expired and pending entries are not restated by a fact.
  // Notes on a project are read with its team memory: a fact the team memory holds is not repeated there.
  const team = input.projectId ? sameMemory({ scope: "project", projectId: input.projectId }) : undefined;
  const where = and(team ? or(sameMemory(input), team) : sameMemory(input), current());
  const { duplicate } = await similarMemories(where, checked.content, embedding);
  if (duplicate) {
    if (duplicate.source === "consolidation" && input.origin === "system" && checked.status === "active") {
      await refreshMemory(duplicate.id);
    }
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
  const counts = noOutcomes();
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
 * Applies the facts consolidated from an agent's journals outside projects. Its craft is read in every
 * project, so a fact that names a project never goes there: it goes to the agent's notes on that project
 * when the agent works on it (the super agent works on all of them), and is dropped otherwise. The rest
 * goes to its craft as usual. `related` are the craft entries the prompt showed; a fact sent to notes is
 * compared with those notes by rememberFact instead.
 */
export async function applyConsolidationOutsideProjects(
  agent: { id: string; kind: string },
  facts: readonly ConsolidatedFact[],
  related: readonly RelatedEntry[],
  origin: "system" | "untrusted",
): Promise<Record<FactOutcome, number>> {
  const every = await projectsOfAgent(agent.id, null, true);
  const members = agent.kind === "orchestrator" ? null : new Set((await projectsOfAgent(agent.id, null)).map((p) => p.id));
  const counts = noOutcomes();
  const craft: ConsolidatedFact[] = [];
  for (const fact of facts) {
    const named = projectNamed(fact.content, every);
    if (!named) {
      craft.push(fact);
      continue;
    }
    if (members && !members.has(named.projectId)) {
      counts.dropped++;
      continue;
    }
    const outcome = await rememberFact({
      scope: "agent",
      agentId: agent.id,
      projectId: named.projectId,
      content: fact.content,
      origin,
      retention: fact.retention,
      validFrom: fact.validFrom,
    });
    counts[outcome]++;
  }
  const done = await applyConsolidation({ scope: "agent", agentId: agent.id, projectId: null }, craft, related, origin);
  for (const outcome of Object.keys(counts) as FactOutcome[]) counts[outcome] += done[outcome];
  return counts;
}

/**
 * Whether the lessons distilled from a project's journals may reach the agent's craft memory, which is
 * read in its other projects: not for a project restricted to some providers, whose data must not reach
 * the others in any form.
 */
export async function craftLessonsAllowed(projectId: string): Promise<boolean> {
  return (await projectProviderPolicy(projectId)).allowed === null;
}

/**
 * Applies the craft lessons distilled from an agent's journals of `projectId` (see craftLessonsPrompt)
 * to the agent's own memory. A lesson that still names one of the agent's projects is dropped, as
 * memory_save refuses it: the prompt asks for generic lessons, this makes sure of it. A lesson never
 * becomes permanent here: permanence is earned by use (promoteRecalledMemories).
 */
export async function applyCraftLessons(
  agentId: string,
  projectId: string,
  lessons: readonly ConsolidatedFact[],
  related: readonly RelatedEntry[],
  origin: "system" | "untrusted",
): Promise<Record<FactOutcome, number>> {
  const projects = await projectsOfAgent(agentId, projectId);
  const generic = lessons
    .filter((lesson) => !namedProject(lesson.content, projects))
    .map((lesson) => ({
      ...lesson,
      retention: lesson.retention === "permanent" ? ("durable" as const) : lesson.retention,
    }));
  const counts = await applyConsolidation({ scope: "agent", agentId, projectId: null }, generic, related, origin);
  return { ...counts, dropped: counts.dropped + lessons.length - generic.length };
}

/**
 * The current entries of the memory consolidation writes to that are closest to its journals, for the
 * model to compare its facts with.
 */
export function consolidationCandidates(target: ConsolidationTarget, journalRows: readonly JournalRow[]) {
  return closestToJournals(and(sameMemory(target), current()), journalRows);
}

type JournalRow = { summary: string; embedding: number[] | null };

/**
 * The entries `where` selects closest to the journals, at most CONSOLIDATION_CANDIDATES: a hybrid search
 * per journal (with the embedding the journal already has), taken in turns so each journal's nearest
 * entries are in.
 */
async function closestToJournals(where: SQL | undefined, journalRows: readonly JournalRow[]) {
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
 * What the agent's other memory layers already hold that is closest to its journals, for consolidation to
 * leave out (see consolidationPrompt's `known`). For notes on a project: the user's rules, the project's
 * team memory and the agent's craft. For the craft (and the super agent, whose project-less journals are
 * routed to its notes on each project): the user's rules, and for the super agent every project's team
 * memory and its own notes.
 */
export async function knownElsewhere(
  target: ConsolidationTarget,
  journalRows: readonly JournalRow[],
  opts: { everyProject?: boolean } = {},
): Promise<string[]> {
  const layers = target.projectId
    ? or(
        sameMemory({ scope: "global" }),
        sameMemory({ scope: "project", projectId: target.projectId }),
        sameMemory({ scope: "agent", agentId: target.agentId, projectId: null }),
      )
    : opts.everyProject
      ? or(
          sameMemory({ scope: "global" }),
          eq(memories.scope, "project"),
          and(eq(memories.scope, "agent"), eq(memories.agentId, target.agentId), isNotNull(memories.projectId)),
        )
      : sameMemory({ scope: "global" });
  return (await closestToJournals(and(layers, current()), journalRows)).map((row) => row.content);
}

/**
 * Who a memory write is for: an agent's page (its craft and its notes on every project), a project's page
 * (its team memory and every agent's notes on it), or none for the memory page. With an owner, entries of
 * other agents or projects are refused as not found.
 */
export type MemoryOwner = { agentId: string } | { projectId: string };

type MemoryWriteOptions = { owner?: MemoryOwner; actor?: string; data?: Record<string, unknown> };

function ownedBy(owner: MemoryOwner | undefined) {
  if (!owner) return undefined;
  return "agentId" in owner
    ? and(eq(memories.scope, "agent"), eq(memories.agentId, owner.agentId))
    : and(ne(memories.scope, "global"), eq(memories.projectId, owner.projectId));
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

/** The audit data of a change to an entry: whose memory it is, and `extra`. */
export const memoryAuditData = (
  memory: Pick<Memory, "scope" | "agentId" | "projectId">,
  extra?: Record<string, unknown>,
) => ({
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
    data: memoryAuditData(row, { origin: row.origin, ...(row.flagReason && { flagReason: row.flagReason }), ...opts.data }),
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
  const embedding = await embedDocument(checked.content, await memoryPolicy(input));
  // Only what agents read: the answer shows these entries to the agent.
  const { duplicate, related } = await similarMemories(and(sameMemory(input), current()), checked.content, embedding);
  if (duplicate) return { duplicateOf: duplicate };
  const memory = await auditCreated(await insertMemory(input, checked, embedding), opts);
  return { memory, related, heldBecause: heldBecause(checked) };
}

/**
 * Replaces an entry's content, checked like a new write. `origin` is whose the new content is; left
 * out (the user's own edit), the entry keeps its origin and is not held. `status` sends an edited entry
 * back for approval when agents' writes need it; flagged content always goes back.
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
      /** The agent run that writes the new content; left out, the content is the user's. */
      runId?: string;
    } = {},
): Promise<{ id: string; heldBecause: string | null }> {
  const [memory] = await ownedMemories([id], opts.owner);
  const origin = opts.origin ?? "owner";
  const checked = await checkMemoryWrite(content, { origin, status: opts.status, knownSecrets: opts.knownSecrets });
  const embedding = await embedDocument(checked.content, await memoryPolicy(memory!));
  const actor = opts.actor ?? "user";
  if (opts.origin && memory!.status === "active" && keepsHistory(memory!.origin)) {
    const row = await insertMemory(
      {
        scope: memory!.scope,
        content: checked.content,
        projectId: memory!.projectId,
        // A team entry's author is who wrote this version; an agent entry stays its owner's.
        agentId: memory!.scope === "project" ? (opts.agentId ?? null) : memory!.agentId,
        source: "agent",
        origin: opts.origin,
        retention: opts.retention ?? memory!.retention,
        pinned: memory!.pinned,
        runId: opts.runId ?? null,
      },
      checked,
      embedding,
    );
    await audit({
      actor,
      action: "memory.updated",
      entityType: "memory",
      entityId: row.id,
      data: memoryAuditData(row, { origin: opts.origin, replaces: id, ...opts.data }),
    });
    await replaceEntries(row, [id], actor);
    return { id: row.id, heldBecause: heldBecause(checked) };
  }
  await db
    .update(memories)
    .set({
      content: checked.content,
      embedding,
      flagReason: checked.flagReason,
      runId: opts.runId ?? null,
      ...(opts.origin && { origin: opts.origin }),
      ...(checked.status && { status: checked.status }),
      ...(opts.retention && {
        retention: opts.retention,
        expiresAt: expiryFor(opts.retention, memory!.validFrom, new Date(), (await getSettings()).memory.ephemeralDays),
      }),
    })
    .where(eq(memories.id, id));
  await audit({
    actor,
    action: "memory.updated",
    entityType: "memory",
    entityId: id,
    data: memoryAuditData(memory!, { ...(opts.origin && { origin: opts.origin }), ...opts.data }),
  });
  return { id, heldBecause: heldBecause(checked) };
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
      data: memoryAuditData(row, { supersededBy: replacement.id }),
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
    data: memoryAuditData(memory!, { ...(memory!.supersededBy && { supersededBy: memory!.supersededBy }), ...opts.data }),
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
    data: memoryAuditData(memory!, opts.data),
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
    data: memoryAuditData(memory!, opts.data),
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

/** Entries agents read: approved, not replaced by a newer fact, and not expired. */
const current = () =>
  and(
    eq(memories.status, "active"),
    isNull(memories.invalidatedAt),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
  );

/**
 * Memories a run may read (see memoryVisibleTo): global, the agent's craft, its notes on the run's project
 * (or the super agent's notes project), and that project's team memory.
 */
function visibleTo(reader: MemoryReader) {
  const notes = notesProject(reader);
  const own = and(eq(memories.scope, "agent"), eq(memories.agentId, reader.agentId));
  return and(
    current(),
    or(
      eq(memories.scope, "global"),
      and(own, isNull(memories.projectId)),
      notes ? and(own, eq(memories.projectId, notes)) : undefined,
      reader.projectId ? and(eq(memories.scope, "project"), eq(memories.projectId, reader.projectId)) : undefined,
    ),
  );
}

/** For the memory a run gets in its prompt (memory-recall.ts). */
export { current as currentMemories, visibleTo as memoriesVisibleTo };

/** Hybrid search (see hybridSearchMemories) over the memories a run may read. */
export async function searchMemories(query: string, opts: MemoryReader & { limit?: number }) {
  // A query made inside a project, or about the super agent's notes on one, may carry its data.
  const vector = await embedQuery(query, await projectProviderPolicy(notesProject(opts)));
  const found = await hybridSearchMemories(query, { vector, where: visibleTo(opts), limit: opts.limit ?? 8 });
  return found.map((m) => ({
    id: m.id,
    scope: m.scope,
    projectId: m.projectId,
    content: m.content,
    updatedAt: m.updatedAt,
    origin: m.origin,
  }));
}

/**
 * Hybrid search across every memory, all scopes, owners and statuses: the memory page. `mode` is
 * "keyword" when the query could not be embedded.
 */
export async function searchAllMemories(query: string, limit = 20) {
  // The user's own query, typed outside any project.
  const vector = await embedQuery(query, ANY_PROVIDER);
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
  const vector = await embedQuery(query, await projectProviderPolicy(opts.projectId ?? null));
  const closed = opts.readableBy ? [...(await projectsClosedTo(opts.readableBy))] : [];
  const scope = and(
    opts.agentId ? eq(journals.agentId, opts.agentId) : undefined,
    journalProject(opts.projectId),
    closed.length ? or(isNull(journals.projectId), notInArray(journals.projectId, closed)) : undefined,
  );
  const found = await hybridSearchJournals(query, { vector, where: scope, limit: opts.limit ?? 5 });
  return found.map((j) => ({ agentId: j.agentId, projectId: j.projectId, day: j.day, summary: j.summary }));
}

/**
 * What a memory write may store, and in which state (see memory-scan.ts for the checks):
 * - a secret refuses the write;
 * - content that came from untrusted data, or that looks like an instruction aimed at the agents,
 *   waits for the user's approval (pending), whatever `memoryRequiresApproval` says;
 * - invisible characters are stripped.
 * The user's own writes are never held for the user's own review; a finding is still recorded.
 */
import { db, memories } from "@abotica/db";
import { and, cosineDistance, eq, isNotNull, sql, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { OWNER_SECRETS, secretValues } from "../platform/vault";
import { restatesFact } from "./memory-facts";
import { FLAG_KINDS, type MemoryFinding, type MemoryFlagKind, scanMemoryContent, stripInvisible } from "./memory-scan";
import { nearestFirst } from "./memory-search";

type Memory = typeof memories.$inferSelect;

/** The write holds a secret; nothing was stored. */
export class MemorySecretError extends UserError {
  constructor(readonly reasons: string[]) {
    super("memory.errors.containsSecret");
  }
}

/** What the agent tools return for a refused write: where the value belongs instead. */
export const SECRET_REFUSED =
  "Not saved: the content contains what looks like a secret (an API key, a token, a password or a private key). Never store secrets in memory: the user keeps the value in the vault (Settings > Vault); save only the secret's name.";

/**
 * The write as it is stored. `status` is undefined when the caller keeps the current one (an edit)
 * and nothing holds the write. `flagReason` is the most serious kind of instruction found.
 */
export type CheckedWrite = {
  content: string;
  status: Memory["status"] | undefined;
  flagReason: MemoryFlagKind | null;
  findings: MemoryFinding[];
};

type WriteCheck = { origin: Memory["origin"]; status?: Memory["status"]; knownSecrets?: readonly string[] };

/** Throws MemorySecretError when `content` holds a secret. */
export function decideMemoryWrite(content: string, { origin, status, knownSecrets }: WriteCheck): CheckedWrite {
  const findings = scanMemoryContent(content, { knownSecrets });
  const secrets = findings.filter((f) => f.kind === "secret");
  if (secrets.length) throw new MemorySecretError(secrets.map((f) => f.reason));
  const flagReason = FLAG_KINDS.find((kind) => findings.some((f) => f.kind === kind)) ?? null;
  const held = origin !== "owner" && (origin === "untrusted" || flagReason !== null);
  return { content: stripInvisible(content), status: held ? "pending" : status, flagReason, findings };
}

/** `decideMemoryWrite` against every vault secret as well as the `knownSecrets` of the caller (a run's repository tokens). */
export async function checkMemoryWrite(content: string, check: WriteCheck): Promise<CheckedWrite> {
  const vault = await secretValues(OWNER_SECRETS);
  return decideMemoryWrite(content, { ...check, knownSecrets: [...(check.knownSecrets ?? []), ...vault] });
}

/** Why an agent's write waits for approval, for the tool's answer; null when it does not. */
export function heldBecause(checked: CheckedWrite, origin: Memory["origin"]): string | null {
  if (checked.status !== "pending") return null;
  if (checked.flagReason) {
    const reason = checked.findings.find((f) => f.kind === checked.flagReason)!.reason;
    return `It looks like ${reason}, so it waits for the user's approval before agents can read it.`;
  }
  if (origin === "untrusted") {
    return "This run read untrusted content (a webhook payload, a web page, a tool result), so it waits for the user's approval before agents can read it.";
  }
  return "Memory written by agents waits for the user's approval.";
}

/** The entries of the memory a write goes to: global memory, one project's or one agent's. */
export function sameMemory(target: { scope: Memory["scope"]; projectId?: string | null; agentId?: string | null }) {
  if (target.scope === "global") return eq(memories.scope, "global");
  return target.scope === "project"
    ? and(eq(memories.scope, "project"), eq(memories.projectId, target.projectId ?? ""))
    : and(eq(memories.scope, "agent"), eq(memories.agentId, target.agentId ?? ""));
}

/** Cosine distance under which two entries state the same fact. */
export const SAME_FACT_DISTANCE = 0.15;

/**
 * Up to which distance an entry is about the same thing as a new fact, which may then replace it.
 * A starting value for text-embedding-3-small, still to calibrate on real data.
 */
export const RELATED_DISTANCE = 0.3;

const MAX_RELATED = 3;

export type SimilarMemory = { id: string; content: string; source: string };

/**
 * The entries `where` selects that a new fact restates (`duplicate`) or is close to (`related`,
 * nearest first). Without an embedding a fact restates an entry only by its text (see restatesFact)
 * and nothing is related.
 */
export async function similarMemories(
  where: SQL | undefined,
  content: string,
  embedding: number[] | null,
): Promise<{ duplicate: SimilarMemory | null; related: SimilarMemory[] }> {
  const fields = { id: memories.id, content: memories.content, source: memories.source };
  if (!embedding) {
    const rows = await db.select(fields).from(memories).where(where);
    return { duplicate: rows.find((row) => restatesFact(content, [row.content])) ?? null, related: [] };
  }
  const distance = cosineDistance(memories.embedding, embedding);
  const nearest = await nearestFirst((tx) =>
    tx
      .select({ row: fields, distance: sql<number>`${distance}` })
      .from(memories)
      .where(and(where, isNotNull(memories.embedding)))
      .orderBy(distance)
      .limit(MAX_RELATED),
  );
  const [closest] = nearest;
  if (closest && Number(closest.distance) < SAME_FACT_DISTANCE) return { duplicate: closest.row, related: [] };
  return { duplicate: null, related: nearest.filter((n) => Number(n.distance) < RELATED_DISTANCE).map((n) => n.row) };
}

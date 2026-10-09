import { db, memories, memoryRecalls } from "@abotica/db";
import { and, count, countDistinct, eq, inArray, isNull, lte, ne, sql } from "@abotica/db/orm";
import { audit } from "../platform/audit";
import { memoryAuditData } from "./memory";
import { promotable } from "./memory-consolidation";

/** The weekly memory upkeep after consolidation: promotion of entries agents keep searching for, expiry. */

/**
 * Makes permanent the durable entries memory_search keeps returning (see promotable): exempt from decay
 * in search from then on. Returns how many.
 */
export async function promoteRecalledMemories(): Promise<number> {
  const searchRecalls = count(memoryRecalls.id);
  const distinctQueries = countDistinct(memoryRecalls.queryHash);
  const candidates = await db
    .select({
      id: memories.id,
      retention: memories.retention,
      origin: memories.origin,
      searchRecalls,
      distinctQueries,
    })
    .from(memoryRecalls)
    .innerJoin(memories, eq(memories.id, memoryRecalls.memoryId))
    .where(
      and(
        eq(memoryRecalls.source, "search"),
        eq(memories.retention, "durable"),
        ne(memories.origin, "untrusted"),
        eq(memories.status, "active"),
        isNull(memories.invalidatedAt),
      ),
    )
    .groupBy(memories.id);
  const ids = candidates.filter(promotable).map((m) => m.id);
  if (!ids.length) return 0;
  // A change of class, not of content: `updatedAt` stays.
  const rows = await db
    .update(memories)
    .set({ retention: "permanent", updatedAt: sql`${memories.updatedAt}` })
    .where(and(inArray(memories.id, ids), eq(memories.retention, "durable")))
    .returning({ id: memories.id, scope: memories.scope, agentId: memories.agentId, projectId: memories.projectId });
  const recalls = new Map(candidates.map((m) => [m.id, m]));
  for (const row of rows) {
    const { searchRecalls, distinctQueries } = recalls.get(row.id)!;
    await audit({
      actor: "system",
      action: "memory.promoted",
      entityType: "memory",
      entityId: row.id,
      data: memoryAuditData(row, { searchRecalls, distinctQueries }),
    });
  }
  return rows.length;
}

/**
 * Deletes the ephemeral entries past their `expiresAt`; agents stopped seeing them then. The audit
 * entry keeps their text. Returns how many.
 */
export async function deleteExpiredMemories(): Promise<number> {
  const rows = await db
    .delete(memories)
    .where(lte(memories.expiresAt, sql`now()`))
    .returning({
      id: memories.id,
      scope: memories.scope,
      agentId: memories.agentId,
      projectId: memories.projectId,
      content: memories.content,
      expiresAt: memories.expiresAt,
    });
  for (const row of rows) {
    await audit({
      actor: "system",
      action: "memory.expired",
      entityType: "memory",
      entityId: row.id,
      data: memoryAuditData(row, { content: row.content, expiresAt: row.expiresAt }),
    });
  }
  return rows.length;
}

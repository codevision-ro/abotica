import type { ModelRef } from "@abotica/db";

/**
 * A compaction: the summary that replaced a conversation's older messages in the model's view (see
 * agents/compaction.ts). It is a row of the conversation with role `system`, the summary as its only
 * text part and this as its metadata. Stored messages are never changed or deleted: the chat shows all
 * of them, with the compaction as a divider. Pure and client-safe: the web chat renders it.
 */
export type CompactionMetadata = {
  kind: "compaction";
  /** ISO time of the last message the summary covers; the model gets only the messages after it. */
  coversUntil: string;
  summary: string;
  /** The model that wrote the summary. */
  model: ModelRef;
  /** Estimated prompt size before and after, in tokens. */
  tokens: { before: number; after: number };
  /** Facts the memory flush saved from the summarized messages. */
  flushedMemoryIds: string[];
  /** Tools the summarized messages called or loaded: they stay loaded, so the run's tool list stays the same. */
  toolsUsed: string[];
  /**
   * The summarized messages (or the summary before this one) held untrusted data (see agents/untrusted.ts):
   * a run given this summary has read it. Missing on summaries without any.
   */
  readUntrusted?: true;
};

/** A compaction with the time it was made. */
export type CompactionRecord = { metadata: CompactionMetadata; createdAt: Date };

export const isCompaction = (metadata: unknown): metadata is CompactionMetadata =>
  typeof metadata === "object" && metadata !== null && (metadata as { kind?: unknown }).kind === "compaction";

/** Whether a message with this creation time is covered by the compaction, so the model no longer gets it. */
export const coveredBy = (compaction: CompactionMetadata, createdAt: Date): boolean =>
  createdAt.getTime() <= Date.parse(compaction.coversUntil);

/**
 * Messages in chat order: each compaction right after the last message it covers, where its divider
 * belongs, rather than at the time it was made (a run compacts after it started, while its answer sorts
 * at its start). `messages` are in creation order.
 */
export function placeCompactions<T extends { metadata: unknown; createdAt: Date }>(messages: T[]): T[] {
  const placed = messages.filter((m) => !isCompaction(m.metadata));
  for (const compaction of messages.filter((m) => isCompaction(m.metadata))) {
    const covers = compaction.metadata as CompactionMetadata;
    // Before the first message it does not cover, so a later compaction of the same messages comes after.
    const next = placed.findIndex((m) => !isCompaction(m.metadata) && !coveredBy(covers, m.createdAt));
    placed.splice(next === -1 ? placed.length : next, 0, compaction);
  }
  return placed;
}

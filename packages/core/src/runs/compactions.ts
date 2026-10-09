import { db, messages, runEvents, runs } from "@abotica/db";
import { and, desc, eq, ne } from "@abotica/db/orm";
import { generateId } from "ai";
import type { CompactionMetadata, CompactionRecord } from "./compaction-record";

/** The database side of compaction (agents/compaction.ts): what a run knows about its prompt before it starts. */

type ConversationUsage = {
  /**
   * The newest step of the conversation's runs: the size of its prompt plus its answer as the provider
   * reported them, when its run started (messages after that were not in it) and when it ran.
   */
  lastStep: { tokens: number; runStartedAt: Date; at: Date } | null;
  /** The conversation's previous run failed because its prompt no longer fit: this one compacts first. */
  overflowed: boolean;
};

type StepUsage = { usage?: { inputTokens?: number; outputTokens?: number } };

export async function conversationUsage(conversationId: string, runId: string): Promise<ConversationUsage> {
  const [[step], [previous]] = await Promise.all([
    db
      .select({ data: runEvents.data, at: runEvents.createdAt, runStartedAt: runs.startedAt })
      .from(runEvents)
      .innerJoin(runs, eq(runs.id, runEvents.runId))
      .where(and(eq(runs.conversationId, conversationId), eq(runEvents.type, "step")))
      .orderBy(desc(runEvents.id))
      .limit(1),
    db
      .select({ failureKind: runs.failureKind })
      .from(runs)
      .where(and(eq(runs.conversationId, conversationId), ne(runs.id, runId)))
      .orderBy(desc(runs.createdAt))
      .limit(1),
  ]);
  const usage = (step?.data as StepUsage | undefined)?.usage;
  return {
    lastStep:
      step && usage
        ? {
            tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            runStartedAt: step.runStartedAt ?? step.at,
            at: step.at,
          }
        : null,
    overflowed: previous?.failureKind === "context_overflow",
  };
}

/** Adds a compaction to the conversation; the messages it covers stay as they are. */
export async function saveCompaction(conversationId: string, metadata: CompactionMetadata): Promise<CompactionRecord> {
  const [row] = await db
    .insert(messages)
    .values({
      id: generateId(),
      conversationId,
      role: "system",
      parts: [{ type: "text", text: metadata.summary }],
      metadata,
    })
    .returning({ createdAt: messages.createdAt });
  return { metadata, createdAt: row!.createdAt };
}

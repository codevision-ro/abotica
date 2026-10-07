import { db, messages } from "@abotica/db";
import { and, asc, eq, sql } from "@abotica/db/orm";
import {
  createUIMessageStream,
  type DynamicToolUIPart,
  generateId,
  isToolUIPart,
  type TextStreamPart,
  toUIMessageStream,
  type ToolSet,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { isWithheldReport } from "../tasks/delegation-report";
import { type CompactionRecord, coveredBy, isCompaction } from "./compaction-record";

/**
 * A run's answer in its conversation. It is saved after every step, so a worker that dies mid-run
 * leaves the finished steps (text, tool calls and their results) for the chat and the next run, and
 * the reaper closes what it left open. Safe for the web app to import: no runner, sandbox or MCP runtime.
 */

type MessageRow = typeof messages.$inferSelect;
type Part = UIMessage["parts"][number];

const toUIMessage = (row: MessageRow) =>
  ({ id: row.id, role: row.role, parts: row.parts, metadata: row.metadata ?? undefined }) as UIMessage;

/** A tool call without a result: still being written, running, or approved and about to run. */
const isOpen = (part: ToolUIPart | DynamicToolUIPart) =>
  part.state === "input-streaming" ||
  part.state === "input-available" ||
  (part.state === "approval-responded" && part.approval.approved);

/**
 * A stopped run leaves tool calls without a result. They are saved as failed with the reason, so
 * the chat shows them stopped rather than still running and the next run tells the model why.
 */
export function closeOpenToolCalls(message: UIMessage, reason: string): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolUIPart(part) && isOpen(part)
        ? ({ ...part, state: "output-error", input: part.input ?? {}, errorText: reason } as Part)
        : part,
    ),
  };
}

/** The run that wrote (or last added to) an answer, so the reaper can find it. */
const withRunId = (message: UIMessage, runId: string): UIMessage => ({
  ...message,
  metadata: { ...(message.metadata as Record<string, unknown> | undefined), runId },
});

export type StoredMessage = { message: UIMessage; createdAt: Date };

/**
 * The history the model gets: the newest compaction, whose summary stands for the messages it covers,
 * and the messages after it. Reports withheld from the agent went to the user only.
 */
export type ConversationHistory = { compaction: CompactionRecord | null; messages: StoredMessage[] };

export async function loadConversation(conversationId: string): Promise<ConversationHistory> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  const newest = rows.findLast((m) => isCompaction(m.metadata));
  const compaction =
    newest && isCompaction(newest.metadata) ? { metadata: newest.metadata, createdAt: newest.createdAt } : null;
  return {
    compaction,
    messages: rows
      .filter((m) => !isCompaction(m.metadata) && !isWithheldReport(m.metadata))
      // Compared here rather than in SQL: a row's time has microseconds, coversUntil (a JS date) does not.
      .filter((m) => !compaction || !coveredBy(compaction.metadata, m.createdAt))
      .map((m) => ({ message: toUIMessage(m), createdAt: m.createdAt })),
  };
}

/**
 * Inserts or updates the message under its id. createdAt is the run start, so an answer sorts before
 * messages the user sent while it ran.
 */
export async function saveMessage(conversationId: string, message: UIMessage, createdAt: Date) {
  const metadata = (message.metadata as Record<string, unknown>) ?? null;
  await db
    .insert(messages)
    .values({ id: message.id, conversationId, createdAt, role: message.role, parts: message.parts, metadata })
    .onConflictDoUpdate({ target: messages.id, set: { parts: message.parts, metadata } });
}

/**
 * The run's answer as UI message chunks, with the run id in its metadata. `save` gets it after every
 * step, and `onEnd` once the stream ends, always under the same id, so its row holds every finished
 * step. A failed step save is logged and the run goes on: the next save carries its parts.
 */
export function responseMessageStream({
  runId,
  stream,
  tools,
  originalMessages,
  onError,
  save,
  onEnd,
}: {
  runId: string;
  stream: ReadableStream<TextStreamPart<ToolSet>>;
  tools: ToolSet;
  originalMessages: UIMessage[];
  onError: (error: unknown) => string;
  save: (message: UIMessage) => Promise<void>;
  onEnd: (end: { responseMessage: UIMessage; isAborted: boolean }) => Promise<void>;
}) {
  const saveStep = async (message: UIMessage) => {
    try {
      await save(withRunId(message, runId));
    } catch (error) {
      console.error(`[runs] saving a step of run ${runId} failed:`, error);
    }
  };
  const last = originalMessages.at(-1);
  // toUIMessageStream does not report steps; this wrapper does, and gives the answer its id.
  return createUIMessageStream({
    originalMessages,
    generateId,
    onError,
    execute: async ({ writer }) => {
      // A continuation (after approvals) adds to the last answer. It becomes this run's before the
      // approved tools run, so the reaper finds it even when the run dies in its first step.
      if (last?.role === "assistant") await saveStep(last);
      writer.merge(toUIMessageStream({ stream, tools, onError }));
    },
    onStepEnd: ({ responseMessage }) => saveStep(responseMessage),
    onEnd: ({ responseMessage, isAborted }) => onEnd({ responseMessage: withRunId(responseMessage, runId), isAborted }),
  });
}

/**
 * Closes the answer of a run that stopped without its runner (the worker died or hangs): its open tool
 * calls fail with `toolError` and a last part says why the run stopped. The chat and the next run then
 * show each finished call with its result and each interrupted one as such. Nothing to do for a run
 * that saved no step.
 */
export async function interruptRunMessage(
  run: { id: string; conversationId: string | null },
  texts: { toolError: string; note: string },
): Promise<void> {
  if (!run.conversationId) return;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, run.conversationId), sql`${messages.metadata}->>'runId' = ${run.id}`))
    .limit(1);
  if (!row) return;
  const closed = closeOpenToolCalls(toUIMessage(row), texts.toolError);
  const parts: Part[] = [...closed.parts, { type: "step-start" }, { type: "text", text: texts.note, state: "done" }];
  await db.update(messages).set({ parts }).where(eq(messages.id, row.id));
}

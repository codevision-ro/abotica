/**
 * Pure rules of the memory a run gets (memory-recall.ts runs the queries): the token budget cut, the
 * recall block added to a user message, and which message gets one. No server imports, so they are
 * testable on their own.
 *
 * Two parts, for the prompt cache: pinned entries go in the system prompt, which stays the same across
 * conversations until a pinned entry changes; entries relevant to a message are recalled into that user
 * message and saved on it (`metadata.recall`), so every later run replays the same bytes.
 */
import type { UIMessage } from "ai";
import { approxTokens } from "../agents/compaction";
import { neutralizeMarkers, splitUntrusted } from "../agents/untrusted";
import type { StoredMessage } from "../runs/run-messages";

/** A memory entry's cost in the prompt, estimated like the rest of it (chars / 4). */
export const memoryTokens = (content: string): number => approxTokens(content);

/**
 * The items that fit `budgetTokens`, taken in order: an item too big for what is left is skipped and
 * smaller ones after it still go in. `omitted` counts the skipped ones.
 */
export function fitBudget<T>(
  items: readonly T[],
  budgetTokens: number,
  tokens: (item: T) => number,
): { kept: T[]; omitted: number; usedTokens: number } {
  const kept: T[] = [];
  let usedTokens = 0;
  for (const item of items) {
    const cost = tokens(item);
    if (usedTokens + cost > budgetTokens) continue;
    kept.push(item);
    usedTokens += cost;
  }
  return { kept, omitted: items.length - kept.length, usedTokens };
}

/** What a user message keeps of its recall: the entries and the exact text the model got. */
export type MessageRecall = { memoryIds: string[]; text: string };

/** The recall saved on a message; null before its first run searched (or for other messages). */
export function recallOf(message: Pick<UIMessage, "metadata">): MessageRecall | null {
  const recall = (message.metadata as { recall?: unknown } | undefined)?.recall;
  if (!recall || typeof recall !== "object") return null;
  const { memoryIds, text } = recall as Partial<MessageRecall>;
  return Array.isArray(memoryIds) && typeof text === "string" ? { memoryIds, text } : null;
}

export const RECALL_HEADER = "Recalled memory (may be relevant to this message; pinned facts are in the instructions):";

/** The same names as the sections of "# Memory" in the instructions, which its priority rule uses. */
const SCOPE_LABEL = { project: "project", agent: "yours", global: "global" } as const;

const RECALL_TAG = /<\s*(\/\s*)?recalled-memory/gi;

/**
 * One entry as a list item. Its own lines are indented under it, and look-alikes of the block's tags and of
 * the untrusted-data markers are rewritten, so an entry cannot end the block or fake another one.
 */
const recallLine = ({ scope, content }: { scope: keyof typeof SCOPE_LABEL; content: string }) =>
  `- [${SCOPE_LABEL[scope]}] ${neutralizeMarkers(content)
    .replace(RECALL_TAG, "[recalled-memory tag removed]")
    .trim()
    .replace(/\r?\n/g, "\n  ")}`;

/** The text part added before a user message, best match first; empty when nothing was recalled. */
export function recallText(entries: readonly { scope: keyof typeof SCOPE_LABEL; content: string }[]): string {
  if (!entries.length) return "";
  return ["<recalled-memory>", RECALL_HEADER, ...entries.map(recallLine), "</recalled-memory>"].join("\n");
}

/** Characters of a message searched with: its start carries the topic, and the embedding has a limit. */
export const RECALL_QUERY_MAX_CHARS = 2000;

/**
 * What recall searches with: the message's text, with the text inside untrusted-data blocks but not their
 * tags; the run's input when the message has no text (only files).
 */
export function recallQuery(message: Pick<UIMessage, "parts">, runInput: string): string {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? splitUntrusted(part.text).map((segment) => segment.text) : []))
    .join("\n")
    .trim();
  return (text || runInput.trim()).slice(0, RECALL_QUERY_MAX_CHARS);
}

/**
 * The message a run recalls memory for: the newest user message, unless it already has its recall (a
 * continuation after approvals, a second run on the same message). Null when there is none to do.
 */
export function recallTarget(messages: readonly StoredMessage[]): number | null {
  const index = messages.findLastIndex((m) => m.message.role === "user");
  if (index === -1 || recallOf(messages[index]!.message)) return null;
  return index;
}

/** Each user message with its recall, as the model gets it (see withSentTimes for the line before it). */
export function withRecall(history: StoredMessage[]): StoredMessage[] {
  return history.map((stored) => {
    const recall = stored.message.role === "user" ? recallOf(stored.message) : null;
    if (!recall?.text) return stored;
    return {
      ...stored,
      message: { ...stored.message, parts: [{ type: "text", text: recall.text }, ...stored.message.parts] },
    };
  });
}

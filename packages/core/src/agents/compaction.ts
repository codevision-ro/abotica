import type { ModelRef } from "@abotica/db";
import type { ModelMessage } from "ai";
import type { CacheTtl, CatalogModel } from "../models/catalog";
import type { CompactionRecord } from "../runs/compaction-record";
import type { StoredMessage } from "../runs/run-messages";
import { UNTRUSTED_NOTE } from "./untrusted";

/**
 * Context compaction: when a conversation's prompt nears the model's context window, its older part is
 * summarized and the model gets the summary instead (Codex, OpenClaw, OpenHands). Only the model's view
 * changes: stored messages stay, and a compaction row records the summary and what it covers
 * (runs/compaction-record.ts). These are the pure parts: when to compact, where to cut, what the
 * summary call gets. Pure: no database, model or runtime imports.
 */

/** Share of the window from which the prompt is compacted whatever it costs (Codex: 9/10). */
export const HARD_SHARE = 0.9;
/**
 * Share from which the prompt is compacted when its prompt cache has expired anyway: compacting while
 * the cache is warm throws away what was paid for it (Mastra's activateAfterIdle, Trigger.dev).
 */
export const SOFT_SHARE = 0.6;
/** Recent messages kept verbatim before the current turn, in tokens (Codex keeps 20k)... */
export const KEEP_RECENT_TOKENS = 20_000;
/** ...and at most this share of the window, so a compaction of a small window still frees room. */
const KEEP_RECENT_SHARE = 0.2;
/**
 * The transcript given to the summary call stays under this share of the window, which leaves room for
 * the call's instructions and its answer.
 */
const TRANSCRIPT_SHARE = 0.75;
/** Tool calls and results are cut to this in the transcript; their start and end are what a summary needs. */
const TOOL_INPUT_MAX_CHARS = 2_000;
const TOOL_RESULT_MAX_CHARS = 4_000;
export const CHARS_PER_TOKEN = 4;
const CACHE_TTL_MS: Record<CacheTtl, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

/** Why a prompt is compacted; `overflow`: a provider rejected it as too long, or the last run failed so. */
export type CompactionReason = "soft" | "hard" | "overflow";

/**
 * The context window the prompt must fit: the smallest of the chain's models, since the fallback can
 * move any step to any of them. Null when the catalog knows none of them (local models): compaction
 * then waits for an overflow error.
 */
export function effectiveWindow(
  chain: ModelRef[],
  catalog: Pick<CatalogModel, "provider" | "id" | "contextWindow">[],
): number | null {
  const windows = chain.flatMap((ref) => {
    const window = catalog.find((m) => m.provider === ref.provider && m.id === ref.model)?.contextWindow;
    return window ? [window] : [];
  });
  return windows.length ? Math.min(...windows) : null;
}

/**
 * What one image costs in a prompt, about: providers count images by their pixels (Anthropic about
 * 1,600 tokens for an image at its largest size), not by the length of their base64.
 */
export const IMAGE_TOKENS = 1600;

/** Base64 shorter than this is left as text: a tiny icon costs little either way. */
const IMAGE_DATA_MIN_CHARS = 1000;

const isImageType = (type: unknown) => typeof type === "string" && type.toLowerCase().startsWith("image/");

/**
 * Tokens of a text, or of a value sent as JSON, at about 4 characters a token. An image inside the
 * value (an object whose mediaType or mimeType is image/*, holding its data in a long string, at any
 * depth below it) counts as IMAGE_TOKENS: a screenshot's base64 alone would count as hundreds of
 * thousands of tokens and compact the conversation for nothing.
 */
export function approxTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / CHARS_PER_TOKEN);
  const images = new WeakSet<object>();
  let imageCount = 0;
  const json =
    JSON.stringify(value, function (this: unknown, _key, item: unknown) {
      const inImage = typeof this === "object" && this !== null && images.has(this);
      if (typeof item === "object" && item !== null) {
        const typed = item as { mediaType?: unknown; mimeType?: unknown };
        if (inImage || isImageType(typed.mediaType) || isImageType(typed.mimeType)) images.add(item);
        return item;
      }
      if (inImage && typeof item === "string" && item.length > IMAGE_DATA_MIN_CHARS) {
        imageCount += 1;
        return "";
      }
      return item;
    }) ?? "";
  return Math.ceil(json.length / CHARS_PER_TOKEN) + imageCount * IMAGE_TOKENS;
}

/** A prompt size in tokens, and the time after which messages are not in it. */
export type MeasuredPrompt = { tokens: number; since: Date };

/**
 * The last known size of the conversation's prompt: the newest step of its runs (`since` its run's
 * start: its answer is counted, messages sent while it ran are not), unless a compaction came after
 * it. Null when the conversation has neither.
 */
export function measuredPrompt(
  compaction: CompactionRecord | null,
  lastStep: { tokens: number; runStartedAt: Date; at: Date } | null,
): MeasuredPrompt | null {
  if (compaction && (!lastStep || lastStep.at < compaction.createdAt)) {
    return { tokens: compaction.metadata.tokens.after, since: compaction.createdAt };
  }
  return lastStep ? { tokens: lastStep.tokens, since: lastStep.runStartedAt } : null;
}

const messagesTokens = (messages: StoredMessage[]) => messages.reduce((sum, m) => sum + approxTokens(m.message.parts), 0);

/**
 * The prompt's size in tokens: the measured size plus about chars/4 for the messages added since.
 * Without a measurement, `fixedTokens` (instructions, tools, the summary) plus every message.
 */
export function estimateTokens(messages: StoredMessage[], measured: MeasuredPrompt | null, fixedTokens: number): number {
  if (!measured) return fixedTokens + messagesTokens(messages);
  return measured.tokens + messagesTokens(messages.filter((m) => m.createdAt > measured.since));
}

/**
 * Whether to compact before the next model call: from HARD_SHARE of the window always, from SOFT_SHARE
 * only when the conversation was idle longer than its prompt cache lives. Never without a window.
 */
export function shouldCompact({
  estimate,
  window,
  idleMs,
  cacheTtl,
}: {
  estimate: number;
  window: number | null;
  idleMs: number;
  cacheTtl: CacheTtl;
}): "hard" | "soft" | null {
  if (window === null) return null;
  if (estimate >= window * HARD_SHARE) return "hard";
  if (estimate >= window * SOFT_SHARE && idleMs > CACHE_TTL_MS[cacheTtl]) return "soft";
  return null;
}

/** Tokens of recent messages kept verbatim; none after an overflow, when every token counts. */
export function keepBudget(reason: CompactionReason, window: number | null, estimate: number): number {
  if (reason === "overflow") return 0;
  return Math.min(KEEP_RECENT_TOKENS, Math.floor((window ?? estimate) * KEEP_RECENT_SHARE));
}

/** A message for `pickCut`: its size, and whether the kept part may start with it. */
export type CutEntry = { tokens: number; cuttable: boolean };

/**
 * Where the kept part of a history starts: the index of its first entry, 0 when nothing would be
 * summarized. Entries from `keepFrom` on (the current turn) are always kept; before them, the most
 * recent ones while they fit in `keepTokens`. The kept part starts only at a cuttable entry, so a tool
 * call is never parted from its result (Trigger.dev's boundary-safe cut).
 */
export function pickCut(entries: CutEntry[], keepFrom: number, keepTokens: number): number {
  let cut = Math.max(0, Math.min(keepFrom, entries.length));
  while (cut > 0 && cut < entries.length && !entries[cut]!.cuttable) cut--;
  let kept = 0;
  for (let i = cut - 1; i >= 0; i--) {
    kept += entries[i]!.tokens;
    if (kept > keepTokens) break;
    if (entries[i]!.cuttable) cut = i;
  }
  return cut;
}

/**
 * The cut of a conversation's stored history: the messages before the index get summarized. The current
 * turn (from the last user message) is kept. A cut never falls between two messages saved in the same
 * millisecond, since `coversUntil` could not tell them apart.
 */
export function historyCut(messages: StoredMessage[], keepTokens: number): number {
  const lastUser = messages.findLastIndex((m) => m.message.role === "user");
  const entries = messages.map((m, i) => ({
    tokens: approxTokens(m.message.parts),
    cuttable: i === 0 || messages[i - 1]!.createdAt < m.createdAt,
  }));
  return pickCut(entries, lastUser === -1 ? messages.length - 1 : lastUser, keepTokens);
}

/**
 * A running run's prompt, cut for a compaction: what to summarize, and what stays after the summary.
 * The prompt is `[summary of an earlier compaction, if any (skip: 1)] [history] [the run's request]
 * [its steps]`, the request being `requestStart` to `requestEnd`. The history and the older steps are
 * summarized; the request and the most recent steps (at least the last) stay. The request goes into the
 * summary call too when steps are summarized, since they answer it. Null when nothing would be summarized.
 */
export function cutRunPrompt(
  messages: ModelMessage[],
  {
    skip,
    requestStart,
    requestEnd,
    keepTokens,
  }: { skip: number; requestStart: number; requestEnd: number; keepTokens: number },
): { summarize: ModelMessage[]; keep: ModelMessage[] } | null {
  const history = messages.slice(skip, requestStart);
  const request = messages.slice(requestStart, requestEnd);
  const steps = messages.slice(requestEnd);
  const lastStep = steps.findLastIndex((m) => m.role === "assistant");
  const entries = steps.map((m) => ({ tokens: approxTokens(m.content), cuttable: m.role !== "tool" }));
  const cut = pickCut(entries, lastStep === -1 ? steps.length : lastStep, keepTokens);
  if (!history.length && cut === 0) return null;
  return {
    summarize: [...history, ...(cut > 0 ? [...request, ...steps.slice(0, cut)] : [])],
    keep: [...request, ...steps.slice(cut)],
  };
}

/** A long text cut in the middle, keeping its start and its end (where a command's output ends). */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max * 2) / 3);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters left out ...]\n${text.slice(text.length - (max - head))}`;
}

const json = (value: unknown) => JSON.stringify(value) ?? String(value);

type Part = { type: string; [key: string]: unknown };

function toolOutputText(output: unknown): string {
  const o = output as { type?: string; value?: unknown; reason?: unknown } | undefined;
  switch (o?.type) {
    case "text":
      return String(o.value);
    case "error-text":
      return `error: ${String(o.value)}`;
    case "json":
      return json(o.value);
    case "error-json":
      return `error: ${json(o.value)}`;
    case "execution-denied":
      return `denied${o.reason ? `: ${String(o.reason)}` : ""}`;
    case "content":
      return Array.isArray(o.value)
        ? o.value.map((item: Part) => (item.type === "text" ? String(item.text) : `[${item.type}]`)).join("\n")
        : "";
    default:
      return json(output);
  }
}

/** A file part names its file, with its URL when it has one; inline bytes are left out. */
function fileLine(part: Part): string {
  const name = String(part.filename ?? part.mediaType ?? "file");
  const data = part.data ?? part.image;
  // A URL, a file reference ({ type: "url", url }) or inline data (base64, bytes, a data URL).
  const ref =
    (data as { type?: unknown; url?: unknown } | undefined)?.type === "url" ? (data as { url: unknown }).url : data;
  const url = ref instanceof URL ? ref.href : typeof ref === "string" ? ref : null;
  return url && /^https?:\/\//.test(url) ? `[file ${name}: ${url}]` : `[file ${name}]`;
}

function partLine(part: Part): string | null {
  switch (part.type) {
    case "text":
      return String(part.text);
    case "image":
    case "file":
      return fileLine(part);
    case "tool-call":
      return `[call ${String(part.toolName)}] ${clip(json(part.input), TOOL_INPUT_MAX_CHARS)}`;
    case "tool-result":
      return `[result of ${String(part.toolName)}] ${clip(toolOutputText(part.output), TOOL_RESULT_MAX_CHARS)}`;
    case "tool-approval-request":
      return "[this call waits for the user's approval]";
    case "tool-approval-response":
      return `[the user ${part.approved ? "approved" : "denied"} the call${part.reason ? `: ${String(part.reason)}` : ""}]`;
    default:
      // Reasoning stays out: the summary is about the work, not how the model thought about it.
      return null;
  }
}

const ROLE_LABELS: Record<ModelMessage["role"], string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

function messageBlock(message: ModelMessage): string {
  const parts: Part[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as Part[]);
  const lines = parts.flatMap((p) => partLine(p) ?? []).filter((line) => line.trim());
  return lines.length ? `[${ROLE_LABELS[message.role]}]\n${lines.join("\n")}` : "";
}

/**
 * The messages to summarize as plain text (OpenClaw's serializeConversation): no tool schemas or
 * provider formats for the summary call to trip on. Long tool calls and results are cut in the middle;
 * when the whole is over `maxTokens`, the oldest messages are left out first.
 */
export function transcript(messages: ModelMessage[], maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const blocks = messages.map(messageBlock).filter(Boolean);
  let total = blocks.reduce((sum, b) => sum + b.length + 2, 0);
  let start = 0;
  while (total > maxChars && start < blocks.length - 1) total -= blocks[start++]!.length + 2;
  const kept = blocks.slice(start).map((b) => clip(b, maxChars));
  return [...(start ? [`[${start} earlier messages left out: too long to summarize]`] : []), ...kept].join("\n\n");
}

/** Tokens the transcript may take in the summary call. */
export const transcriptBudget = (window: number | null, estimate: number): number =>
  Math.floor((window ?? estimate) * TRANSCRIPT_SHARE);

const SUMMARY_SECTIONS = `## Goal
What the user wants, every goal if there are several.

## Constraints & Preferences
What the user asked for or ruled out, and how they want the work done. "(none)" if nothing.

## Progress
### Done
### In Progress
### Blocked

## Key Decisions
Each decision with its reason.

## Next Steps
In order.

## Critical Context
Data, references and exact values the next steps need. "(none)" if nothing.`;

const KEEP_EXACTLY = `Keep these exactly as they appear, wherever they matter for the work:
- task ids and titles with their status; delegated tasks still waiting for their report; tool calls waiting for the user's approval
- repository names, branches (such as abotica/task-...), the last known git state (commits, what is pushed), pull request URLs
- file ids, file URLs and workspace paths
- decisions and the user's preferences, and the questions still open
- exact error messages, commands and identifiers the next steps need
Name a secret, never copy its value; text shown as [redacted] stays [redacted].`;

const MEMORY_FLUSH = `Before you write the summary, save to memory with memory_save the durable facts of these messages that later conversations need: the user's preferences, decisions and their reasons, facts about a project. Save each fact once, as a sentence that stands on its own; skip what is only true for now (work in progress, next steps belong in the summary). If there is nothing durable, save nothing. Then answer with the summary.`;

/**
 * The summary call: instructions and the prompt with the messages to summarize, on top of the previous
 * summary when there is one (VoltAgent's incremental summary). With `flush`, the call also has
 * memory_save and is asked to save durable facts first (OpenClaw's memory flush).
 */
export function summaryRequest({
  transcript,
  previousSummary,
  flush,
}: {
  transcript: string;
  previousSummary: string | null;
  flush: boolean;
}): { system: string; prompt: string } {
  const system = [
    "You compact the context of an AI agent's conversation. It no longer fits the model's context window, so its earlier part is replaced by your summary: the agent goes on from your summary and the most recent messages alone. Write it as a handoff to the agent, with everything it needs to continue without asking again.",
    ...(flush ? [MEMORY_FLUSH] : []),
    UNTRUSTED_NOTE,
    `Answer with the summary only, in this format:\n\n${SUMMARY_SECTIONS}`,
    KEEP_EXACTLY,
    ...(previousSummary
      ? [
          "A previous summary covers the messages before these. Your summary replaces it: carry over what still holds, update what changed (move finished work to Done, update the next steps) and add what is new.",
        ]
      : []),
  ].join("\n\n");
  const prompt = [
    ...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>`] : []),
    `<messages>\n${transcript}\n</messages>`,
    previousSummary ? "Update the summary with the messages above." : "Summarize the messages above.",
  ].join("\n\n");
  return { system, prompt };
}

/** What opens the summary in the prompt (Codex's summary_prefix.md). */
export const SUMMARY_PREFIX =
  "Summary of the earlier part of this conversation, written by an assistant when the conversation grew too long for the context window. The messages it covers were left out of this prompt; the messages after it follow as they were.";

/** The summary as the model gets it: a user message, since a system message mid-conversation is not portable. */
export const summaryMessage = (summary: string): ModelMessage => ({
  role: "user",
  content: `${SUMMARY_PREFIX}\n\n${summary}`,
});

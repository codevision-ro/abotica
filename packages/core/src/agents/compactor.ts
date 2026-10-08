import type { ModelRef } from "@abotica/db";
import { convertToModelMessages, generateText, isStepCount, type ModelMessage, type Tool } from "ai";
import { type CacheTtl, estimateCost } from "../models/catalog";
import { FallbackModel } from "../models/fallback-model";
import { ContextOverflowError } from "../models/provider-errors";
import { OWNER_SECRETS, secretValues } from "../platform/vault";
import type { CompactionMetadata, CompactionRecord } from "../runs/compaction-record";
import { conversationUsage, saveCompaction } from "../runs/compactions";
import { logRunEvent } from "../runs/run-lifecycle";
import type { ConversationHistory, StoredMessage } from "../runs/run-messages";
import {
  approxTokens,
  type CompactionReason,
  cutRunPrompt,
  estimateTokens,
  HARD_SHARE,
  historyCut,
  keepBudget,
  measuredPrompt,
  shouldCompact,
  summaryMessage,
  summaryRequest,
  transcript,
  transcriptBudget,
} from "./compaction";
import { type RunContext, withSentTimes } from "./context";
import { builtinPermission } from "./permissions";
import { redactSecrets } from "./redact";
import type { StepPreparer } from "./step-preparation";
import { toolsUsedIn } from "./tool-loading";
import { memoryTools } from "./tools/memory";
import { modelMessagesHaveUntrusted, wrapUntrustedResults } from "./untrusted-results";

/**
 * Compaction in a run (see compaction.ts for the rules): at its start, when its first model call
 * overflows, and once mid-run as a step preparer. The summary comes from the run's own model chain, so
 * it reaches only providers the run may use; its cost is the run's. A compaction that fails is logged
 * and the run goes on with its prompt as it was.
 */

/** Steps of the summary call: the memory flush gets all but the last, which answers with the summary. */
const SUMMARY_STEPS = 4;
/**
 * The summary call's own time limit: it can run before the run's stream and its total timeout, so a
 * provider that stops answering fails the compaction (the run goes on uncompacted) instead of the run.
 */
const SUMMARY_TIMEOUT_MS = 3 * 60_000;

/** What a compaction call cost, added to the run's. */
export type CompactionUsage = { costUsd: number; inputTokens: number; outputTokens: number };

/** `readUntrusted`: what it summarizes held untrusted data (see CompactionMetadata). */
type Summary = {
  text: string;
  model: ModelRef;
  flushedMemoryIds: string[];
  usage: CompactionUsage;
  readUntrusted: boolean;
};

export type CompactorOptions = {
  ctx: RunContext;
  conversationId: string;
  chain: ModelRef[];
  /** The context window the prompt must fit (effectiveWindow); null when unknown. */
  window: number | null;
  cacheTtl: CacheTtl;
  signal: AbortSignal;
  /** Instructions and tools, for a conversation whose prompt size was never measured. */
  fixedTokens: number;
  onUsage: (usage: CompactionUsage) => Promise<void>;
  errorText: (error: unknown) => string;
};

/** Tools a history keeps loaded: the ones its messages used, and the ones its summary stands for. */
export const toolsUsedInHistory = (history: ConversationHistory): Set<string> =>
  new Set([...toolsUsedIn(history.messages.map((m) => m.message)), ...(history.compaction?.metadata.toolsUsed ?? [])]);

/** The history's prompt messages: the summary, then the messages after it. */
export const summaryMessages = (history: ConversationHistory): ModelMessage[] =>
  history.compaction ? [summaryMessage(history.compaction.metadata.summary)] : [];

/**
 * memory_save for the memory flush, as the agent's permission has it: none when denied. Where the
 * agent must ask first, the facts are saved pending, since nobody can approve a call in a compaction.
 * Facts drawn from untrusted data (`readUntrusted`) are saved as untrusted, as the run's own would be.
 */
function flushTool(ctx: RunContext, readUntrusted: boolean): Tool | null {
  const permission = builtinPermission(ctx.agent.permissions, "memory_save", ctx.agent);
  if (permission === "deny") return null;
  const pending = permission === "ask" || ctx.settings.memoryRequiresApproval;
  return memoryTools.memory_save!({
    ...ctx,
    untrustedSeen: ctx.untrustedSeen || readUntrusted,
    settings: { ...ctx.settings, memoryRequiresApproval: pending },
  });
}

const messagesTokens = (messages: StoredMessage[]) => approxTokens(messages.map((m) => m.message.parts));
const promptTokens = (messages: ModelMessage[]) => approxTokens(messages.map((m) => m.content));

export function createCompactor(opts: CompactorOptions) {
  const { ctx, conversationId, window, signal } = opts;
  const runId = ctx.run.id;
  const logInBackground = (type: string, data: Record<string, unknown>) =>
    logRunEvent(runId, type, data).catch((error: unknown) =>
      console.error(`[runs] logging a ${type} event of ${runId} failed:`, error),
    );
  const model = new FallbackModel(opts.chain, {
    onFallback: (e) => logInBackground("fallback", e),
    onRetry: (e) => logInBackground("retry", e),
  });
  /** The latest estimate of the prompt's size. */
  let estimate = 0;

  /**
   * The summary of `messages` on top of the previous one, without secret values: the vault's and the
   * repositories' are replaced before the call and in what it returns. Untrusted data in the messages
   * (or behind the previous summary) makes the flush's facts untrusted and the run one that read it.
   */
  async function summarize(messages: ModelMessage[], previous: CompactionMetadata | null): Promise<Summary> {
    const secrets = [...ctx.repos.map((r) => r.token), ...(await secretValues(OWNER_SECRETS))];
    const readUntrusted = previous?.readUntrusted === true || modelMessagesHaveUntrusted(messages);
    const flush = flushTool(ctx, readUntrusted);
    const request = summaryRequest({
      transcript: transcript(redactSecrets(messages, secrets), transcriptBudget(window, estimate)),
      previousSummary: previous === null ? null : redactSecrets(previous.summary, secrets),
      flush: flush !== null,
    });
    const usage: CompactionUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    // Steps that ran count for the run even when a later one fails.
    const result = await generateText({
      model,
      instructions: request.system,
      prompt: request.prompt,
      tools: flush ? { memory_save: flush } : {},
      stopWhen: isStepCount(SUMMARY_STEPS),
      prepareStep: ({ stepNumber }) => (stepNumber === SUMMARY_STEPS - 1 ? { toolChoice: "none" } : undefined),
      abortSignal: signal,
      timeout: { totalMs: SUMMARY_TIMEOUT_MS },
      maxRetries: 0,
      onStepEnd: async (step) => {
        const served = model.lastServed;
        const tokens = {
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          cachedInputTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        };
        usage.costUsd += await estimateCost(served.provider, served.model, tokens);
        usage.inputTokens += tokens.inputTokens;
        usage.outputTokens += tokens.outputTokens;
      },
    }).finally(() => opts.onUsage(usage));
    // The answer is the last step's text; a model that wrote it before its last memory call left it earlier.
    const text = [...result.steps]
      .reverse()
      .find((s) => s.text.trim())
      ?.text.trim();
    if (!text) throw new Error("The summary call returned no text");
    const flushedMemoryIds = result.steps.flatMap((s) =>
      s.toolResults.flatMap((r) => {
        const id = (r.output as { id?: unknown } | undefined)?.id;
        return r.toolName === "memory_save" && typeof id === "string" ? [id] : [];
      }),
    );
    // The model gets the summary in place of the messages: what they held, it has read.
    if (readUntrusted) ctx.untrustedSeen = true;
    return { text: redactSecrets(text, secrets), model: model.lastServed, flushedMemoryIds, usage, readUntrusted };
  }

  /**
   * Logs the compaction as a run event and, when it covers stored messages, saves it for the next runs;
   * returns the saved compaction.
   */
  async function record(
    {
      reason,
      midRun,
      summary,
      tokens,
    }: { reason: CompactionReason; midRun: boolean; summary: Summary; tokens: CompactionMetadata["tokens"] },
    covers: Pick<CompactionMetadata, "coversUntil" | "toolsUsed"> | null,
  ): Promise<CompactionRecord | null> {
    const saved = covers
      ? await saveCompaction(conversationId, {
          kind: "compaction",
          summary: summary.text,
          model: summary.model,
          tokens,
          flushedMemoryIds: summary.flushedMemoryIds,
          ...covers,
          ...(summary.readUntrusted && { readUntrusted: true }),
        })
      : null;
    await logRunEvent(runId, "compaction", {
      reason,
      midRun,
      ...tokens,
      model: summary.model,
      costUsd: summary.usage.costUsd,
      inputTokens: summary.usage.inputTokens,
      outputTokens: summary.usage.outputTokens,
      flushedMemoryIds: summary.flushedMemoryIds,
      summary: summary.text,
    });
    return saved;
  }

  /** A failed compaction is not the run's failure: the run goes on with its prompt as it was. */
  async function failed(reason: CompactionReason, error: unknown): Promise<null> {
    if (signal.aborted) throw error;
    await logRunEvent(runId, "compaction-error", { reason, error: opts.errorText(error) });
    return null;
  }

  /** Summarizes the history's older part and saves the compaction; null when nothing was compacted. */
  async function compactHistory(
    history: ConversationHistory,
    reason: CompactionReason,
  ): Promise<ConversationHistory | null> {
    const cut = historyCut(history.messages, keepBudget(reason, window, estimate));
    if (cut === 0) return null;
    const covered = history.messages.slice(0, cut);
    try {
      // With the calls that never got a result: the summary says what was left open. Without the run's
      // tools, so every untrusted result is wrapped here and the summary call reads it as data.
      const messages = wrapUntrustedResults(
        await convertToModelMessages(withSentTimes(covered, ctx.settings.timezone)),
        {},
        () => {},
      );
      const previous = history.compaction?.metadata ?? null;
      const summary = await summarize(messages, previous);
      const after = Math.max(
        0,
        estimate - messagesTokens(covered) - (previous ? approxTokens(previous.summary) : 0) + approxTokens(summary.text),
      );
      const compaction = await record(
        { reason, midRun: false, summary, tokens: { before: estimate, after } },
        {
          coversUntil: covered.at(-1)!.createdAt.toISOString(),
          toolsUsed: [...toolsUsedInHistory({ compaction: history.compaction, messages: covered })],
        },
      );
      estimate = after;
      return { compaction, messages: history.messages.slice(cut) };
    } catch (error) {
      return failed(reason, error);
    }
  }

  return {
    /**
     * Before the run's first model call: compacts when the prompt passes the hard share of the window,
     * or the soft one after the prompt cache expired, or when the previous run overflowed.
     */
    async atStart(history: ConversationHistory): Promise<ConversationHistory> {
      const usage = await conversationUsage(conversationId, runId);
      estimate = estimateTokens(history.messages, measuredPrompt(history.compaction, usage.lastStep), opts.fixedTokens);
      const idleMs = usage.lastStep ? Date.now() - usage.lastStep.at.getTime() : Number.POSITIVE_INFINITY;
      const reason = usage.overflowed ? "overflow" : shouldCompact({ estimate, window, idleMs, cacheTtl: opts.cacheTtl });
      if (!reason) return history;
      return (await compactHistory(history, reason)) ?? history;
    },

    /** The run's first model call overflowed: compacts as much as it can. Null when nothing could be. */
    async onOverflow(history: ConversationHistory): Promise<ConversationHistory | null> {
      estimate = Math.max(estimate, window ?? 0);
      return compactHistory(history, "overflow");
    },

    /**
     * The mid-run compaction, as the last step preparer: when the next step's prompt passes the hard
     * share of the window, the history and the older steps become a summary, followed by the run's
     * request and its recent steps. At most once a run (OpenClaw's loop guard): a second time the run
     * fails as overflowed, and the next run starts with a compaction. `history` is what the run's
     * prompt was built from.
     */
    midRun(history: ConversationHistory): StepPreparer {
      const skip = history.compaction ? 1 : 0;
      let request = { start: 0, end: 0 };
      /** Prompt messages the last step was sent; the ones after them are new. */
      let sent = 0;
      let compacted = false;
      return async ({ stepNumber, steps, messages }) => {
        if (stepNumber === 0) {
          const lastUser = messages.findLastIndex((m, i) => i >= skip && m.role === "user");
          request = { start: lastUser === -1 ? messages.length : lastUser, end: messages.length };
          sent = messages.length;
          return null;
        }
        const added = promptTokens(messages.slice(sent));
        estimate = (steps.at(-1)?.usage.inputTokens ?? 0) + added;
        sent = messages.length;
        if (window === null || estimate < window * HARD_SHARE) return null;
        if (compacted) throw new ContextOverflowError();
        compacted = true;
        const cut = cutRunPrompt(messages, {
          skip,
          requestStart: request.start,
          requestEnd: request.end,
          keepTokens: keepBudget("hard", window, estimate),
        });
        if (!cut) return null;
        try {
          const summary = await summarize(cut.summarize, history.compaction?.metadata ?? null);
          const prompt = [summaryMessage(summary.text), ...cut.keep];
          const after = Math.max(0, estimate - promptTokens(messages) + promptTokens(prompt));
          // Saved for the next runs when it covers stored messages: the history before the run's request.
          const covers = historyCut(history.messages, 0);
          const covered = history.messages.slice(0, covers);
          await record(
            { reason: "hard", midRun: true, summary, tokens: { before: estimate, after } },
            covers > 0
              ? {
                  coversUntil: covered.at(-1)!.createdAt.toISOString(),
                  toolsUsed: [...toolsUsedInHistory({ compaction: history.compaction, messages: covered })],
                }
              : null,
          );
          estimate = after;
          sent = prompt.length;
          return { messages: prompt };
        } catch (error) {
          return failed("hard", error);
        }
      };
    },
  };
}

import { approvals, db, runs } from "@abotica/db";
import { convertToModelMessages, type StopCondition, streamText, type ToolSet, type UIMessageChunk } from "ai";
import { eq } from "@abotica/db/orm";
import { createHmac } from "node:crypto";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import { applicableBudgets, type MonthlyBudget, tightestBudget } from "../platform/budgets";
import { type CacheTtl, estimateCost, getCatalog } from "../models/catalog";
import { env } from "../infra/env";
import { publish } from "../infra/events";
import { availableProviders, NoModelError } from "../models/chain";
import { NoAllowedProviderError } from "../models/provider-policy";
import { getFile, readFileBytes } from "../files/files";
import { notify } from "../infra/queues";
import { abortKind, failureKindOf, type RunFailureKind } from "../runs/run-failures";
import { cancelClaimedRun, claimRun, failRun, finishRun, logRunEvent } from "../runs/run-lifecycle";
import {
  closeOpenToolCalls,
  type ConversationHistory,
  loadConversation,
  loadUnsteeredMessages,
  markSteered,
  responseMessageStream,
  saveMessage,
  type StoredMessage,
} from "../runs/run-messages";
import type { Run } from "../runs/runs";
import { isKillSwitchActive } from "../platform/kill-switch";
import { settingsLocale } from "../platform/settings";
import { approxTokens, effectiveWindow } from "./compaction";
import { createCompactor, summaryMessages, toolsUsedInHistory } from "./compactor";
import { buildInstructions, type DeferredToolGroup, loadRunContext, type RunContext, withSentTimes } from "./context";
import { withRecall } from "../memory/memory-budget";
import { recallForRun } from "../memory/memory-recall";
import { FallbackModel } from "../models/fallback-model";
import { modelRole, roleDefaultEffort } from "../models/model-role";
import { inheritedEffort } from "../models/reasoning";
import type { McpToolSource } from "./mcp";
import { loadMcpTools, type McpConnection } from "./mcp-runtime";
import { withModelFiles } from "./message-files";
import { fullModelChain, modelChain } from "./model-chain";
import { builtinPermission, mcpRunPermission } from "./permissions";
import { loadRepoInstructions } from "./repo-instructions";
import { openRunSandbox } from "./sandbox-session";
import { answerSegments, createSteering, stepStarts, withUndeliveredNotes } from "./steering";
import { prepareSteps } from "./step-preparation";
import { createRunStreamWriter } from "./stream";
import { loopGuard } from "./stuck";
import { deferTools, isDeferredBuiltin, TOOL_SEARCH } from "./tool-loading";
import { builtinTools } from "./tools";
import { messagesHaveUntrusted } from "./untrusted";
import { wrapUntrustedResults } from "./untrusted-results";

/** Progress of a running run; status changes go through run-lifecycle. */
type RunProgress = Pick<
  typeof runs.$inferInsert,
  "provider" | "model" | "steps" | "inputTokens" | "outputTokens" | "costUsd"
>;

/** HMAC secret binding approvals to the exact tool call; derived so it survives restarts. */
const approvalSecret = () => createHmac("sha256", env().VAULT_KEY).update("tool-approvals").digest("hex");

async function updateProgress(runId: string, progress: RunProgress) {
  await db.update(runs).set(progress).where(eq(runs.id, runId));
}

/** Keeps `ctx.untrustedSeen` for the day's journal, whose facts it makes untrusted (maintenance.ts). */
async function markReadUntrusted(runId: string) {
  await db.update(runs).set({ readUntrusted: true }).where(eq(runs.id, runId));
}

/** For callbacks nobody awaits: a failed write is logged instead of becoming an unhandled rejection. */
function logEventInBackground(runId: string, type: string, data: Record<string, unknown>) {
  logRunEvent(runId, type, data).catch((error: unknown) =>
    console.error(`[runs] logging a ${type} event of ${runId} failed:`, error),
  );
}

/**
 * Lifetime of the Anthropic prompt cache. The steps of a run follow each other within seconds, so
 * 5 minutes is enough; a conversation that resumes after a pause (a person replying, the results of
 * delegated work) keeps its cache with 1 hour, whose writes cost 2x the input price instead of 1.25x.
 */
function cacheTtl(ctx: RunContext): CacheTtl {
  const resumes = ctx.run.trigger === "chat" || ctx.run.trigger === "telegram" || ctx.agent.kind !== "specialist";
  return resumes ? "1h" : "5m";
}

type ToolApproval = NonNullable<Parameters<typeof streamText<ToolSet>>[0]["toolApproval"]>;

/** Effective permission of a tool in the run's tool set; skill_read and tool_search are always allowed. */
function toolPermission(ctx: RunContext, mcpSources: Record<string, McpToolSource>, name: string) {
  const source = mcpSources[name];
  if (source) return mcpRunPermission(ctx.agent.permissions, source, ctx.readOnlyMcpServers);
  if (name === "skill_read" || name === TOOL_SEARCH) return "allow";
  return builtinPermission(ctx.agent.permissions, name, ctx.agent);
}

/** Denied tools never reach the model; this only decides between running directly and asking. */
function approvalPolicy(ctx: RunContext, mcpSources: Record<string, McpToolSource>): ToolApproval {
  return async ({ toolCall }) => {
    const name = toolCall.toolName;
    // Do not ask the user to approve a call that is going to fail validation anyway.
    if (name === "agent_create") {
      const provider = (toolCall.input as { provider?: string } | undefined)?.provider?.trim();
      if (provider && !(await availableProviders()).some((p) => p.id === provider)) return undefined;
    }
    return toolPermission(ctx, mcpSources, name) === "allow" ? undefined : "user-approval";
  };
}

/** The deferred tools for the prompt: built-ins first, then each MCP server in run order. */
function deferredGroups(
  ctx: RunContext,
  deferred: string[],
  mcpSources: Record<string, McpToolSource>,
): DeferredToolGroup[] {
  const builtin = deferred.filter((name) => !mcpSources[name]);
  const groups = builtin.length ? [{ source: "Built-in", names: builtin }] : [];
  for (const server of ctx.mcpServers) {
    const names = deferred.filter((name) => mcpSources[name]?.serverSlug === server.slug);
    if (names.length) groups.push({ source: `MCP server ${server.name}`, names });
  }
  return groups;
}

/** Why the run stopped before its answer, when a limit inside the loop stopped it. */
type Stop = { reason: string; kind: RunFailureKind };

/** Stops that leave the work unfinished: the run fails and its task is blocked. The others end it as answered. */
const FAILING_STOPS = new Set<RunFailureKind>(["loop", "step_limit", "timeout"]);

/** The total timeout aborts the stream with this reason (AbortSignal.timeout). */
const isTimeout = (reason: unknown) => reason instanceof DOMException && reason.name === "TimeoutError";

export type ExecuteResult = {
  status: "succeeded" | "failed" | "cancelled" | "waiting_approval";
  output?: string;
};

/** What the worker hears about a run while it executes. */
export type RunHooks = {
  /** User messages the run took in between its steps (see steering.ts), e.g. to acknowledge them on Telegram. */
  onSteered?: (messages: StoredMessage[]) => Promise<void>;
};

/** A steered message's text for the run's timeline. */
const preview = (message: StoredMessage["message"]) =>
  message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : p.type === "file" ? [`[${p.filename ?? p.mediaType}]`] : []))
    .join(" ")
    .slice(0, 300);

const outcome = (end: Run | null, status: ExecuteResult["status"], output?: string): ExecuteResult | null =>
  end ? { status, output } : null;

/**
 * Executes one run end to end. Safe to call once per run id: only a run still queued is claimed, so
 * one cancelled meanwhile never starts. Null when there is nothing left to do for the run: it was not
 * claimed, or something else ended it meanwhile.
 */
export async function executeRun(runId: string, signal: AbortSignal, hooks: RunHooks = {}): Promise<ExecuteResult | null> {
  const run = await claimRun(runId);
  if (!run) return null;
  try {
    return await executeClaimed(run, signal, hooks);
  } catch (error) {
    // executeClaimed ends the run itself once it has its context; this is a failure to load it.
    const message = error instanceof Error ? error.message : String(error);
    return outcome(await failRun(run, message, failureKindOf(error)), "failed");
  }
}

async function executeClaimed(run: Run, signal: AbortSignal, hooks: RunHooks): Promise<ExecuteResult | null> {
  const runId = run.id;
  const ctx = await loadRunContext(runId);

  // Run errors are stored as text and shown as-is, so they are written in the configured language.
  const t = getTranslator(settingsLocale(ctx.settings));
  const errorText = (error: unknown) =>
    isUserError(error) ? translateKey(t, error.key, error.values) : error instanceof Error ? error.message : String(error);

  const fail = async (error: string, kind: RunFailureKind) => outcome(await failRun(run, error, kind), "failed");
  const cancel = async (reason: string, kind: RunFailureKind) =>
    outcome(await cancelClaimedRun(run, reason, kind), "cancelled");
  const finish = async (status: "succeeded" | "waiting_approval", output: string, error?: string | null) =>
    outcome(await finishRun(run, { status, output, error, actor: `agent:${ctx.agent.slug}` }), status, output);

  const startedAt = run.startedAt ?? new Date();
  const limits = ctx.agent.limits;
  const writer = createRunStreamWriter(runId);
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let stop: Stop | null = null;
  let streamError: Stop | null = null;
  /** Records why the loop stops; the first condition to stop it explains it. */
  const stopWith = (reason: string, kind: RunFailureKind) => {
    stop ??= { reason, kind };
    return true;
  };

  const monthlyBudgetReached = (budget: MonthlyBudget) =>
    budget.scope === "global"
      ? t("errors.run.globalBudgetReached", { budget: budget.budgetUsd })
      : t("errors.run.projectBudgetReached", { project: budget.name });
  // The monthly budget with the least left at the start, and how much this run may spend of it.
  let monthly: ReturnType<typeof tightestBudget> = null;
  const budgetReached = () => {
    if (limits.budgetUsd != null && cost >= limits.budgetUsd) {
      return stopWith(t("errors.run.runBudgetReached", { budget: limits.budgetUsd }), "budget");
    }
    // Runs running at the same time do not share this headroom: each counts only its own cost, so
    // together they can go past the budget.
    if (monthly && cost >= monthly.remainingUsd) return stopWith(monthlyBudgetReached(monthly.budget), "budget");
    return false;
  };
  /**
   * Why the run fails, if it does: a stop that leaves the work unfinished, or the error that ended the
   * stream (the model's, after the run made steps or before).
   */
  const runFailure = () => (stop && FAILING_STOPS.has(stop.kind) ? stop : null) ?? streamError;
  /** The prompt did not fit the model before the run made a step: compacted, it can start again. */
  const overflowedBeforeFirstStep = () => steps === 0 && streamError?.kind === "context_overflow" && !signal.aborted;
  const stopReason = () => stop?.reason ?? null;
  // A limit hit inside the loop explains itself; otherwise the worker passed why it aborted.
  const abortReason = () =>
    stopReason() ??
    (signal.reason instanceof Error && signal.reason.message ? signal.reason.message : t("errors.run.cancelled"));
  const killed = async () => (await isKillSwitchActive()) && stopWith(t("errors.run.stoppedByKillSwitch"), "kill_switch");
  // Stop conditions run only after a step whose tool calls all have results: the run was still working.
  const stepLimitReached: StopCondition<ToolSet> = ({ steps }) =>
    steps.length >= limits.maxSteps && stopWith(t("errors.run.stepLimitReached", { steps: limits.maxSteps }), "step_limit");
  const loop = loopGuard((found, text) => logEventInBackground(runId, "loop-nudge", { ...found, text }));
  const loopDetected: StopCondition<ToolSet> = ({ steps }) => {
    const found = loop.stopping(steps);
    return found !== null && stopWith(t("errors.run.loopDetected", { tool: found.tools.join(", ") }), "loop");
  };

  // Everything after the claim runs inside the try, so the run always ends; the finally stops the MCP
  // processes and the sandbox session (on Docker nothing else would end those execs and their proxy tokens).
  let mcp: McpConnection | undefined;
  try {
    if (await isKillSwitchActive()) return await cancel(t("errors.run.killSwitchActive"), "kill_switch");
    if (!ctx.agent.enabled) return await fail(t("errors.run.agentDisabled", { agent: ctx.agent.slug }), "agent_disabled");
    monthly = tightestBudget(await applicableBudgets(ctx.project));
    if (monthly && monthly.remainingUsd <= 0) return await fail(monthlyBudgetReached(monthly.budget), "budget");
    if (!fullModelChain(ctx).length) return await fail(errorText(new NoModelError()), "no_model");
    const chain = await modelChain(ctx);
    if (!chain.length) return await fail(errorText(new NoAllowedProviderError()), "provider_not_allowed");
    // Its conversation was deleted (runs keep a null conversation then): there is nothing to answer.
    const conversationId = ctx.run.conversationId;
    if (!conversationId) return await fail(t("runs.errors.noConversation"), "no_conversation");

    let history = await loadConversation(conversationId);
    // A webhook payload or a delegation report in the prompt, or a summary of untrusted data; wrapped
    // tool results set it as they come.
    ctx.untrustedSeen ||=
      history.compaction?.metadata.readUntrusted === true || messagesHaveUntrusted(history.messages.map((m) => m.message));
    // Memory relevant to the newest message, saved on it; a failed recall leaves the run without one.
    history = await recallForRun(history, {
      id: runId,
      input: ctx.run.input,
      agentId: ctx.agent.id,
      projectId: ctx.projectId,
      notesProjectId: ctx.notesProjectId,
      settings: ctx.settings,
    }).catch((error: unknown) => {
      logEventInBackground(runId, "recall-error", { error: errorText(error) });
      return history;
    });

    const model = new FallbackModel(chain, {
      effort: inheritedEffort(
        ctx.conversation?.reasoningEffort,
        ctx.agent.reasoningEffort,
        roleDefaultEffort(ctx.settings, modelRole(ctx.agent)),
      ),
      onFallback: (e) => logEventInBackground(runId, "fallback", e),
      onRetry: (e) => logEventInBackground(runId, "retry", e),
    });

    // A broken sandbox must not fail the run: the agent continues without workspace tools.
    ctx.sandbox = await openRunSandbox(ctx, signal).catch((error: unknown) => {
      logEventInBackground(runId, "sandbox-error", { error: errorText(error) });
      return null;
    });
    // Before the instructions are built; it opens the workspace of a task run in a project with repositories.
    ctx.repoInstructions = await loadRepoInstructions(ctx, {
      signal,
      onError: (error) => logEventInBackground(runId, "sandbox-error", { error: errorText(error) }),
    });
    mcp = await loadMcpTools(ctx.mcpServers, {
      signal,
      secrets: { projectId: ctx.projectId },
      runWorkspace: ctx.sandbox ? () => ctx.sandbox!.workspace() : null,
      toolOutput: ctx.sandbox ? { sandbox: ctx.sandbox, runId } : null,
      onUntrusted: () => {
        ctx.untrustedSeen = true;
      },
      knownSecrets: ctx.repos.map((r) => r.token),
      onLazyError: (server, error) => logEventInBackground(runId, "mcp-error", { error: `${server}: ${errorText(error)}` }),
    });
    for (const { server, error } of mcp.errors)
      await logRunEvent(runId, "mcp-error", { error: `${server}: ${errorText(error)}` });
    const mcpSources = mcp.sources;
    const available: ToolSet = builtinTools(ctx);
    for (const [name, t] of Object.entries(mcp.tools)) {
      if (toolPermission(ctx, mcpSources, name) !== "deny") available[name] = t;
    }
    // MCP tools and rarely used built-ins load on demand; what this conversation used stays loaded,
    // including what a compaction summarized, so the tool list does not change with it.
    const { tools, deferred } = deferTools(
      available,
      (name) => name in mcpSources || isDeferredBuiltin(name),
      toolsUsedInHistory(history),
    );

    // Anthropic caches only up to marked blocks: the top-level marker moves to the end of the
    // conversation on every step, and the one on the instructions caches tools and system prompt,
    // which the agent's other conversations share. Other providers cache prefixes on their own.
    // Both stay when a compaction replaces the messages: the top-level one is a request option.
    // OpenAI routes requests with the same key to the same cache: the conversation's steps and runs share it.
    const ttl = cacheTtl(ctx);
    const cacheOptions = { anthropic: { cacheControl: { type: "ephemeral", ttl } } } as const;
    const requestOptions = { ...cacheOptions, openai: { promptCacheKey: conversationId } };
    const instructions = await buildInstructions(ctx, deferredGroups(ctx, deferred, mcpSources));
    const compactor = createCompactor({
      ctx,
      conversationId,
      chain,
      window: effectiveWindow(chain, await getCatalog()),
      cacheTtl: ttl,
      signal,
      fixedTokens:
        approxTokens(instructions) + approxTokens(Object.entries(tools).map(([name, t]) => [name, t.description])),
      onUsage: async (usage) => {
        cost += usage.costUsd;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        await updateProgress(runId, { inputTokens, outputTokens, costUsd: cost });
      },
      errorText,
    });
    history = await compactor.atStart(history);

    /** Stored messages as model input: the history, and the messages steered in mid-run the same way. */
    const toModel = async (messages: StoredMessage[]) =>
      // Results of tools this run lacks and stored errors go in wrapped too, as their tools would.
      wrapUntrustedResults(
        await convertToModelMessages(
          await withModelFiles(withSentTimes(withUndeliveredNotes(withRecall(messages)), ctx.settings.timezone), {
            store: { get: getFile, read: readFileBytes },
            workspace: ctx.sandbox !== null,
            readsDirectly: (mediaType) => model.acceptsSomewhere(mediaType),
          }),
          { tools, ignoreIncompleteToolCalls: true },
        ),
        tools,
        () => {
          ctx.untrustedSeen = true;
        },
      );

    const startStream = async (prompt: ConversationHistory) => {
      const steering = createSteering({
        load: () => loadUnsteeredMessages(conversationId, startedAt),
        mark: (ids, afterStep) => markSteered(ids, { runId, afterStep }),
        toModel: (messages) => {
          // A delegation report steered in brings its untrusted outputs, as it would at the start.
          ctx.untrustedSeen ||= messagesHaveUntrusted(messages.map((m) => m.message));
          return toModel(messages);
        },
        inPrompt: prompt.messages.map((m) => m.message.id),
        onSteered: async ({ step, messages }) => {
          await logRunEvent(runId, "steered", {
            afterStep: step - 1,
            messages: messages.map((m) => ({ id: m.message.id, text: preview(m.message) })),
          });
          await hooks.onSteered?.(messages);
        },
        onError: (error) => logEventInBackground(runId, "steering-error", { error: errorText(error) }),
      });
      // A continuation adds to the last answer: its step starts come before this run's.
      const continued = prompt.messages.at(-1)?.message;
      const baseSteps = continued?.role === "assistant" ? stepStarts(continued.parts) : 0;
      const saveAnswer = async (message: StoredMessage["message"]) => {
        for (const segment of answerSegments(message, startedAt, steering.steers, baseSteps)) {
          await saveMessage(conversationId, segment.message, segment.createdAt);
        }
      };

      const result = streamText({
        model,
        instructions: { role: "system", content: instructions, providerOptions: cacheOptions },
        providerOptions: requestOptions,
        messages: [...summaryMessages(prompt), ...(await toModel(prompt.messages))],
        tools,
        toolApproval: approvalPolicy(ctx, mcpSources),
        experimental_sandbox: ctx.sandbox ?? undefined,
        experimental_toolApprovalSecret: approvalSecret(),
        // In this order, so the first that holds explains the stop.
        stopWhen: [budgetReached, loopDetected, stepLimitReached, killed],
        // Messages from outside the run first, then notices about the run, then what shortens the prompt
        // (see step-preparation.ts). Steered messages go at the end of the prompt, so its cached prefix stays.
        prepareStep: prepareSteps([steering.preparer, loop.nudge, compactor.midRun(prompt)]),
        abortSignal: signal,
        timeout: { totalMs: limits.timeoutMs },
        // The worker's abort is a cancel; the total timeout fails the run.
        onAbort: ({ reason }) => {
          if (!signal.aborted && isTimeout(reason)) {
            stopWith(t("errors.run.timedOut", { minutes: Math.round(limits.timeoutMs / 60_000) }), "timeout");
          }
        },
        maxRetries: 0,
        onStepEnd: async (step) => {
          steps += 1;
          const served = model.lastServed;
          const usage = {
            inputTokens: step.usage.inputTokens ?? 0,
            outputTokens: step.usage.outputTokens ?? 0,
            cachedInputTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          };
          const stepCost = await estimateCost(served.provider, served.model, usage, ttl);
          cost += stepCost;
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          await logRunEvent(runId, "step", {
            step: step.stepNumber,
            provider: served.provider,
            model: served.model,
            reasoningEffort: model.lastEffort,
            finishReason: step.finishReason,
            text: step.text,
            reasoning: step.reasoningText,
            toolCalls: step.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })),
            toolResults: step.toolResults.map((r) => ({ id: r.toolCallId, name: r.toolName, output: r.output })),
            toolErrors: step.content.flatMap((p) =>
              p.type === "tool-error" ? [{ id: p.toolCallId, name: p.toolName, error: errorText(p.error) }] : [],
            ),
            usage,
            costUsd: stepCost,
          });
          await updateProgress(runId, {
            provider: served.provider,
            model: served.model,
            steps,
            inputTokens,
            outputTokens,
            costUsd: cost,
          });
        },
      });

      const uiStream = responseMessageStream({
        runId,
        stream: result.stream,
        tools,
        // The messages after the summary: the answer's id comes from the last one.
        originalMessages: prompt.messages.map((m) => m.message),
        // The first error is the cause: the message stream reports it again as a plain error with its text.
        onError: (error) => {
          streamError ??= { reason: errorText(error), kind: failureKindOf(error) };
          return streamError.reason;
        },
        // A failed tool call is the model's to handle: it reads the error and the run goes on.
        toolErrorText: errorText,
        // Saved after every step, so a worker that dies mid-run leaves the finished steps in the chat.
        // Reasoning is saved with the answer, since the next turn replays it to the model.
        save: saveAnswer,
        onEnd: async ({ responseMessage, isAborted }) => {
          const message =
            isAborted || signal.aborted ? closeOpenToolCalls(responseMessage, abortReason()) : responseMessage;
          if (message.parts.length) await saveAnswer(message);
        },
      });
      return { result, uiStream };
    };

    let { result, uiStream } = await startStream(history);
    // A first model call that overflows gets one more try on a compacted prompt. Until a step starts,
    // the chunks wait, so the chat does not show the error of a call that is tried again.
    for (let restarted = false; ; restarted = true) {
      const held: UIMessageChunk[] = [];
      let stepStarted = restarted;
      const reader = uiStream.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const chunk = next.value;
        // Chats show answers, not the model thinking aloud; the reasoning stays in the run trace.
        if (chunk.type.startsWith("reasoning-")) continue;
        stepStarted ||= chunk.type === "start-step";
        if (!stepStarted) {
          held.push(chunk);
          continue;
        }
        for (const waiting of held.splice(0)) await writer.write(waiting);
        await writer.write(chunk);
      }
      if (!restarted && overflowedBeforeFirstStep()) {
        // Reloaded: approved calls that ran before the overflow are saved with their results, so they do not run again.
        const compacted = await compactor.onOverflow(await loadConversation(conversationId));
        if (compacted) {
          history = compacted;
          streamError = null;
          ({ result, uiStream } = await startStream(history));
          continue;
        }
      }
      for (const waiting of held) await writer.write(waiting);
      break;
    }

    if (signal.aborted) return await cancel(abortReason(), abortKind(signal.reason));
    const failed = runFailure();
    if (failed) return await fail(failed.reason, failed.kind);

    const content = await result.content;
    const pending = content.filter((p) => p.type === "tool-approval-request" && !p.isAutomatic);
    const output = (await result.finalStep).text.trim();

    if (pending.length) {
      // All at once, so deciding the first one never sees the run with nothing else pending.
      const rows = await db
        .insert(approvals)
        .values(
          pending.flatMap((p) =>
            p.type === "tool-approval-request"
              ? [
                  {
                    runId,
                    agentId: ctx.agent.id,
                    approvalId: p.approvalId,
                    toolName: p.toolCall.toolName,
                    toolCallId: p.toolCall.toolCallId,
                    input: p.toolCall.input,
                    reason: p.reason ?? null,
                  },
                ]
              : [],
          ),
        )
        .returning({ id: approvals.id });
      const result = await finish("waiting_approval", output);
      for (const row of rows) {
        await publish({ type: "approval.created", approvalId: row.id });
        await notify({ kind: "approval", approvalId: row.id });
      }
      return result;
    }

    // A run a budget or the kill switch stopped keeps what it answered so far, with the reason.
    return await finish("succeeded", output, stopReason());
  } catch (error) {
    if (signal.aborted) return await cancel(abortReason(), abortKind(signal.reason));
    const failed = runFailure() ?? { reason: errorText(error), kind: failureKindOf(error) };
    return await fail(failed.reason, failed.kind);
  } finally {
    // Each step runs even when an earlier one fails.
    const cleanup = await Promise.allSettled([
      writer.end(),
      mcp?.close(),
      ctx.sandbox?.close(),
      ctx.untrustedSeen && markReadUntrusted(runId),
    ]);
    for (const r of cleanup) if (r.status === "rejected") console.error(`[runs] cleanup of ${runId} failed:`, r.reason);
  }
}

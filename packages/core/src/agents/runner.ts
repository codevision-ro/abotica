import { approvals, db, messages, runs } from "@abotica/db";
import {
  convertToModelMessages,
  generateId,
  isStepCount,
  isToolUIPart,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
import { asc, eq } from "@abotica/db/orm";
import { createHmac } from "node:crypto";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import { applicableBudgets, type MonthlyBudget, tightestBudget } from "../platform/budgets";
import { isWithheldReport } from "../tasks/delegation-report";
import { type CacheTtl, estimateCost } from "../models/catalog";
import { env } from "../infra/env";
import { publish } from "../infra/events";
import { availableProviders, NoModelError } from "../models/chain";
import { NoAllowedProviderError } from "../models/provider-policy";
import { getFile, readFileBytes } from "../files/files";
import { notify } from "../infra/queues";
import { cancelClaimedRun, claimRun, failRun, finishRun, logRunEvent } from "../runs/run-lifecycle";
import type { Run } from "../runs/runs";
import { isKillSwitchActive } from "../platform/kill-switch";
import { settingsLocale } from "../platform/settings";
import { buildInstructions, type DeferredToolGroup, loadRunContext, type RunContext, sentAtLine } from "./context";
import { FallbackModel } from "../models/fallback-model";
import { inheritedEffort } from "../models/reasoning";
import type { McpToolSource } from "./mcp";
import { loadMcpTools, type McpConnection } from "./mcp-runtime";
import { withModelFiles } from "./message-files";
import { fullModelChain, modelChain } from "./model-chain";
import { builtinPermission, mcpToolPermission } from "./permissions";
import { openRunSandbox } from "./sandbox-session";
import { createRunStreamWriter } from "./stream";
import { deferTools, isDeferredBuiltin, TOOL_SEARCH, toolsUsedIn } from "./tool-loading";
import { builtinTools } from "./tools";

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
  const resumes = ctx.run.trigger === "chat" || ctx.run.trigger === "telegram" || ctx.agent.isOrchestrator || ctx.isManager;
  return resumes ? "1h" : "5m";
}

type ToolApproval = NonNullable<Parameters<typeof streamText<ToolSet>>[0]["toolApproval"]>;

/** Effective permission of a tool in the run's tool set; skill_read and tool_search are always allowed. */
function toolPermission(ctx: RunContext, mcpSources: Record<string, McpToolSource>, name: string) {
  const source = mcpSources[name];
  if (source) return mcpToolPermission(ctx.agent.permissions, source.serverSlug, source.tool);
  if (name === "skill_read" || name === TOOL_SEARCH) return "allow";
  return builtinPermission(ctx.agent.permissions, name, {
    isOrchestrator: ctx.agent.isOrchestrator,
    isManager: ctx.isManager,
  });
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

/**
 * A stopped run leaves tool calls without a result. They are saved as failed with the reason, so
 * the chat shows them stopped rather than still running and the next run tells the model why.
 */
function closeOpenToolCalls(message: UIMessage, reason: string): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolUIPart(part) && (part.state === "input-streaming" || part.state === "input-available")
        ? ({ ...part, state: "output-error", input: part.input ?? {}, errorText: reason } as UIMessage["parts"][number])
        : part,
    ),
  };
}

type StoredMessage = { message: UIMessage; createdAt: Date };

/** The history the model gets: reports withheld from the agent went to the user only. */
async function loadConversation(conversationId: string): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  return rows
    .filter((m) => !isWithheldReport(m.metadata))
    .map((m) => ({
      message: { id: m.id, role: m.role, parts: m.parts, metadata: m.metadata ?? undefined } as UIMessage,
      createdAt: m.createdAt,
    }));
}

/** The history as the model gets it: every user message opens with the time it was sent. */
function withSentTimes(history: StoredMessage[], timezone: string): UIMessage[] {
  return history.map(({ message, createdAt }) =>
    message.role === "user"
      ? { ...message, parts: [{ type: "text", text: sentAtLine(createdAt, timezone) }, ...message.parts] }
      : message,
  );
}

/** createdAt is the run start, so an answer sorts before messages the user sent while it ran. */
async function saveMessage(conversationId: string, message: UIMessage, createdAt: Date) {
  await db
    .insert(messages)
    .values({
      id: message.id,
      conversationId,
      createdAt,
      role: message.role,
      parts: message.parts,
      metadata: (message.metadata as Record<string, unknown>) ?? null,
    })
    .onConflictDoUpdate({ target: messages.id, set: { parts: message.parts } });
}

export type ExecuteResult = {
  status: "succeeded" | "failed" | "cancelled" | "waiting_approval";
  output?: string;
};

const outcome = (end: Run | null, status: ExecuteResult["status"], output?: string): ExecuteResult | null =>
  end ? { status, output } : null;

/**
 * Executes one run end to end. Safe to call once per run id: only a run still queued is claimed, so
 * one cancelled meanwhile never starts. Null when there is nothing left to do for the run: it was not
 * claimed, or something else ended it meanwhile.
 */
export async function executeRun(runId: string, signal: AbortSignal): Promise<ExecuteResult | null> {
  const run = await claimRun(runId);
  if (!run) return null;
  try {
    return await executeClaimed(run, signal);
  } catch (error) {
    // executeClaimed ends the run itself once it has its context; this is a failure to load it.
    return outcome(await failRun(run, error instanceof Error ? error.message : String(error)), "failed");
  }
}

async function executeClaimed(run: Run, signal: AbortSignal): Promise<ExecuteResult | null> {
  const runId = run.id;
  const ctx = await loadRunContext(runId);

  // Run errors are stored as text and shown as-is, so they are written in the configured language.
  const t = getTranslator(settingsLocale(ctx.settings));
  const errorText = (error: unknown) =>
    isUserError(error) ? translateKey(t, error.key, error.values) : error instanceof Error ? error.message : String(error);

  const fail = async (error: string) => outcome(await failRun(run, error), "failed");
  const cancel = async (reason: string) => outcome(await cancelClaimedRun(run, reason), "cancelled");
  const finish = async (status: "succeeded" | "waiting_approval", output: string, error?: string | null) =>
    outcome(await finishRun(run, { status, output, error, actor: `agent:${ctx.agent.slug}` }), status, output);

  const startedAt = run.startedAt ?? new Date();
  const limits = ctx.agent.limits;
  const writer = createRunStreamWriter(runId);
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let stopReason: string | null = null;
  let streamError: string | null = null;

  const monthlyBudgetReached = (budget: MonthlyBudget) =>
    budget.scope === "global"
      ? t("errors.run.globalBudgetReached", { budget: budget.budgetUsd })
      : t("errors.run.projectBudgetReached", { project: budget.name });
  // The monthly budget with the least left at the start, and how much this run may spend of it.
  let monthly: ReturnType<typeof tightestBudget> = null;
  const budgetReached = () => {
    if (limits.budgetUsd != null && cost >= limits.budgetUsd) {
      stopReason = t("errors.run.runBudgetReached", { budget: limits.budgetUsd });
      return true;
    }
    // Runs running at the same time do not share this headroom: each counts only its own cost, so
    // together they can go past the budget.
    if (monthly && cost >= monthly.remainingUsd) {
      stopReason = monthlyBudgetReached(monthly.budget);
      return true;
    }
    return false;
  };
  // A limit hit inside the loop explains itself; otherwise the worker passed why it aborted.
  const abortReason = () =>
    stopReason ??
    (signal.reason instanceof Error && signal.reason.message ? signal.reason.message : t("errors.run.cancelled"));
  const killed = async () => {
    if (await isKillSwitchActive()) {
      stopReason = t("errors.run.stoppedByKillSwitch");
      return true;
    }
    return false;
  };

  // Everything after the claim runs inside the try, so the run always ends; the finally stops the MCP
  // processes and the sandbox session (on Docker nothing else would end those execs and their proxy tokens).
  let mcp: McpConnection | undefined;
  try {
    if (await isKillSwitchActive()) return await cancel(t("errors.run.killSwitchActive"));
    if (!ctx.agent.enabled) return await fail(t("errors.run.agentDisabled", { agent: ctx.agent.slug }));
    monthly = tightestBudget(await applicableBudgets(ctx.project));
    if (monthly && monthly.remainingUsd <= 0) return await fail(monthlyBudgetReached(monthly.budget));
    if (!fullModelChain(ctx).length) return await fail(errorText(new NoModelError()));
    const chain = await modelChain(ctx);
    if (!chain.length) return await fail(errorText(new NoAllowedProviderError()));
    // Its conversation was deleted (runs keep a null conversation then): there is nothing to answer.
    const conversationId = ctx.run.conversationId;
    if (!conversationId) return await fail(t("runs.errors.noConversation"));

    const history = await loadConversation(conversationId);
    const uiMessages = history.map((h) => h.message);

    const model = new FallbackModel(chain, {
      effort: inheritedEffort(
        ctx.conversation?.reasoningEffort,
        ctx.agent.reasoningEffort,
        ctx.settings.defaultReasoningEffort,
      ),
      onFallback: (e) => logEventInBackground(runId, "fallback", e),
    });

    // A broken sandbox must not fail the run: the agent continues without workspace tools.
    ctx.sandbox = await openRunSandbox(ctx, signal).catch((error: unknown) => {
      logEventInBackground(runId, "sandbox-error", { error: errorText(error) });
      return null;
    });
    mcp = await loadMcpTools(ctx.mcpServers, {
      signal,
      secrets: { projectId: ctx.projectId },
      runWorkspace: ctx.sandbox ? () => ctx.sandbox!.workspace() : null,
      onLazyError: (server, error) => logEventInBackground(runId, "mcp-error", { error: `${server}: ${errorText(error)}` }),
    });
    for (const { server, error } of mcp.errors)
      await logRunEvent(runId, "mcp-error", { error: `${server}: ${errorText(error)}` });
    const mcpSources = mcp.sources;
    const available: ToolSet = builtinTools(ctx);
    for (const [name, t] of Object.entries(mcp.tools)) {
      const { serverSlug, tool } = mcpSources[name]!;
      if (mcpToolPermission(ctx.agent.permissions, serverSlug, tool) !== "deny") available[name] = t;
    }
    // MCP tools and rarely used built-ins load on demand; what this conversation used stays loaded.
    const { tools, deferred } = deferTools(
      available,
      (name) => name in mcpSources || isDeferredBuiltin(name),
      toolsUsedIn(uiMessages),
    );

    // Anthropic caches only up to marked blocks: the top-level marker moves to the end of the
    // conversation on every step, and the one on the instructions caches tools and system prompt,
    // which the agent's other conversations share. Other providers cache prefixes on their own.
    const ttl = cacheTtl(ctx);
    const cacheOptions = { anthropic: { cacheControl: { type: "ephemeral", ttl } } } as const;
    const result = streamText({
      model,
      instructions: {
        role: "system",
        content: await buildInstructions(ctx, deferredGroups(ctx, deferred, mcpSources)),
        providerOptions: cacheOptions,
      },
      providerOptions: cacheOptions,
      messages: await convertToModelMessages(
        await withModelFiles(withSentTimes(history, ctx.settings.timezone), {
          store: { get: getFile, read: readFileBytes },
          workspace: ctx.sandbox !== null,
          readsDirectly: (mediaType) => model.acceptsSomewhere(mediaType),
        }),
        { tools, ignoreIncompleteToolCalls: true },
      ),
      tools,
      toolApproval: approvalPolicy(ctx, mcp.sources),
      experimental_sandbox: ctx.sandbox ?? undefined,
      experimental_toolApprovalSecret: approvalSecret(),
      stopWhen: [isStepCount(limits.maxSteps), budgetReached, killed],
      abortSignal: signal,
      timeout: { totalMs: limits.timeoutMs },
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

    const uiStream = toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: uiMessages,
      generateMessageId: generateId,
      // Reasoning is saved with the answer, since the next turn replays it to the model.
      onError: (error) => {
        streamError = errorText(error);
        return streamError;
      },
      onEnd: async ({ responseMessage, isAborted }) => {
        const message = isAborted || signal.aborted ? closeOpenToolCalls(responseMessage, abortReason()) : responseMessage;
        if (message.parts.length) await saveMessage(conversationId, message, startedAt);
      },
    });
    const reader = uiStream.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      // Chats show answers, not the model thinking aloud; the reasoning stays in the run trace.
      if (!next.value.type.startsWith("reasoning-")) await writer.write(next.value);
    }

    if (signal.aborted) return await cancel(abortReason());

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

    return await finish("succeeded", output, stopReason);
  } catch (error) {
    if (signal.aborted) return await cancel(abortReason());
    return await fail(streamError ?? errorText(error));
  } finally {
    // Each step runs even when an earlier one fails.
    const cleanup = await Promise.allSettled([writer.end(), mcp?.close(), ctx.sandbox?.close()]);
    for (const r of cleanup) if (r.status === "rejected") console.error(`[runs] cleanup of ${runId} failed:`, r.reason);
  }
}

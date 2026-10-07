/**
 * How a resolved reasoning effort and the replayed reasoning reach each provider. The AI SDK
 * `reasoning` call option carries the levels it knows and handles each model's quirks; what it
 * cannot express ("max", provider toggles, Anthropic block binding) goes in `providerOptions`.
 */
import { getModelCapabilities } from "@ai-sdk/anthropic/internal";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ProviderId } from "./catalog";
import type { ReasoningEffort } from "./reasoning";

type ReasoningRequest = Pick<LanguageModelV4CallOptions, "reasoning" | "providerOptions">;

/** The call options for one effort on one model of the provider; "default" sends no effort. */
type ProviderReasoning = (effort: ReasoningEffort, model: string) => ReasoningRequest;

type SdkReasoning = NonNullable<LanguageModelV4CallOptions["reasoning"]>;

/** The AI SDK option, which stops at "xhigh". */
function sdkReasoning(effort: ReasoningEffort): ReasoningRequest {
  if (effort === "default") return {};
  return { reasoning: (effort === "max" ? "xhigh" : effort) satisfies SdkReasoning };
}

/** "max" sent natively under the provider's options key; the other levels through the AI SDK. */
const withNativeMax =
  (key: string, field: string): ProviderReasoning =>
  (effort) =>
    effort === "max" ? { providerOptions: { [key]: { [field]: "max" } } } : sdkReasoning(effort);

/** Replayed thinking whose conversation prefix changed is dropped instead of failing the request. */
const DROP_STALE_THINKING = { prefixMismatchBehavior: "drop_block" } as const;

/**
 * Anthropic. Adaptive models get the same request the AI SDK builds for a level (adaptive
 * thinking, summarized for the run trace, plus `effort`), written out so "max" fits. Models that
 * always think bind replayed thinking to the exact prefix (system prompt, tools, history); a
 * prefix that changed between runs would fail with "Invalid signature", so stale blocks are
 * dropped. "none" and budget-only models stay with the AI SDK mapping.
 */
const anthropic: ProviderReasoning = (effort, model) => {
  const caps = getModelCapabilities(model);
  if (effort === "none" || !caps.supportsAdaptiveThinking) return sdkReasoning(effort);
  const blockBinding = caps.rejectsThinkingDisabled ? DROP_STALE_THINKING : undefined;
  if (effort === "default") {
    return blockBinding ? { providerOptions: { anthropic: { thinking: { type: "adaptive", blockBinding } } } } : {};
  }
  return {
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive", display: "summarized", ...(blockBinding && { blockBinding }) },
        effort: anthropicEffort(effort, caps.supportsXhighEffort),
      },
    },
  };
};

/** Catalog models arrive already resolved; this covers ids the catalog does not know yet. */
function anthropicEffort(effort: Exclude<ReasoningEffort, "default" | "none">, supportsXhigh: boolean) {
  if (effort === "minimal") return "low";
  if (effort === "xhigh" && !supportsXhigh) return "max";
  return effort;
}

/**
 * OpenAI (Responses API), stateless: responses are not stored at OpenAI, reasoning comes back
 * encrypted with the answer and is replayed from the saved messages instead of item references.
 */
const openaiEffort = withNativeMax("openai", "reasoningEffort");
const openai: ProviderReasoning = (effort, model) => {
  const request = openaiEffort(effort, model);
  return { ...request, providerOptions: mergeProviderOptions(request.providerOptions, { openai: { store: false } }) };
};

/** Kimi: thinking is turned off with its own `thinking` field, levels go as `reasoning_effort`. */
const moonshot: ProviderReasoning = (effort) => {
  if (effort === "default") return {};
  if (effort === "none") return { providerOptions: { moonshot: { thinking: { type: "disabled" } } } };
  return { providerOptions: { moonshot: { reasoningEffort: effort } } };
};

/** A new provider must say how it takes reasoning; `sdkReasoning` covers the plain case. */
const PROVIDER_REASONING: Record<ProviderId, ProviderReasoning> = {
  anthropic,
  openai,
  deepseek: withNativeMax("deepseek", "reasoningEffort"),
  moonshot,
  ollama: withNativeMax("ollama", "reasoningEffort"),
};

/** The call options that carry `effort` to `model`; unknown providers get the AI SDK option. */
export function reasoningRequest(provider: string, model: string, effort: ReasoningEffort): ReasoningRequest {
  const forProvider = PROVIDER_REASONING[provider as ProviderId] ?? sdkReasoning;
  return forProvider(effort, model);
}

/** Merges per-provider option objects one level deep; later sources win. */
export function mergeProviderOptions(
  ...sources: (SharedV4ProviderOptions | undefined)[]
): SharedV4ProviderOptions | undefined {
  const merged: SharedV4ProviderOptions = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) merged[key] = { ...merged[key], ...value };
  }
  return Object.keys(merged).length ? merged : undefined;
}

/** Metadata key on reasoning parts that records which provider produced them. */
export const ORIGIN_KEY = "abotica";

/** The provider that produced a saved reasoning part, when it can be told. */
function reasoningOrigin(providerOptions: SharedV4ProviderOptions | undefined): string | undefined {
  const stamped = providerOptions?.[ORIGIN_KEY]?.provider;
  if (typeof stamped === "string") return stamped;
  // Parts saved before stamping: signatures and encrypted reasoning name their provider.
  if (providerOptions?.anthropic) return "anthropic";
  if (providerOptions?.openai) return "openai";
  return undefined;
}

/**
 * Drops reasoning another provider produced. OpenAI and Anthropic skip it with a warning, but
 * DeepSeek and OpenAI-compatible providers would replay it as the model's own `reasoning_content`.
 */
export function ownReasoningOnly(prompt: LanguageModelV4Prompt, provider: string): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((part) => {
      if (part.type !== "reasoning") return true;
      const origin = reasoningOrigin(part.providerOptions);
      return origin === undefined || origin === provider;
    });
    return content.length === message.content.length ? message : { ...message, content };
  });
}

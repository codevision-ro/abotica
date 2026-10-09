import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { EmbeddingModel } from "ai";
import { UserError } from "@abotica/i18n";
import { isLocalProvider, isProviderId, isSubscriptionProviderId, type ProviderId } from "./catalog";
import { type CloudProviderId, DEFAULT_PROVIDER_BASE_URLS } from "./provider-info";
import { getSettings } from "../settings/settings";
import type { EmbeddingProvider, ModelSettings } from "../settings/settings-schema";
import { getSecret } from "../platform/vault";
import { ollamaBase } from "./ollama";
import { EMBEDDING_PROFILES, LOCAL_EMBEDDING_MODEL } from "./embedding-profiles";
import { localEmbeddingStatus } from "./local-embeddings";
import { isSubscriptionConnected, subscriptionLanguageModel } from "./subscriptions/connections";

/** The vault name of each provider's API key, set in Settings; null for a local server. */
export const PROVIDER_KEY_SECRET: Record<ProviderId, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  ollama: null,
};

/**
 * The address a cloud provider is called at: the one set in Settings, else the SDK's own (undefined).
 * Moonshot goes through the generic OpenAI-compatible client, which has no address of its own.
 */
export function providerBaseUrl(baseUrls: ModelSettings["baseUrls"], provider: CloudProviderId): string | undefined {
  return baseUrls[provider] ?? (provider === "moonshot" ? DEFAULT_PROVIDER_BASE_URLS.moonshot : undefined);
}

async function apiKey(provider: ProviderId): Promise<string> {
  if (isLocalProvider(provider)) return "ollama";
  const name = PROVIDER_KEY_SECRET[provider];
  const key = name ? await getSecret(name) : undefined;
  if (!key) throw new ProviderNotConfiguredError(provider);
  return key;
}

export class ProviderNotConfiguredError extends UserError {
  constructor(readonly provider: string) {
    super("errors.providerNotConfigured");
  }
}

/** How a provider is connected: its API key, its plan (the two exclude each other), or the local server. */
export type ProviderConnection = "api-key" | "plan" | "local";

export async function providerConnection(provider: ProviderId): Promise<ProviderConnection | null> {
  if (isLocalProvider(provider)) return (await getSettings()).models.ollama.enabled ? "local" : null;
  if (isSubscriptionProviderId(provider) && (await isSubscriptionConnected(provider))) return "plan";
  const name = PROVIDER_KEY_SECRET[provider];
  return name && (await getSecret(name)) ? "api-key" : null;
}

export async function isProviderConfigured(provider: ProviderId): Promise<boolean> {
  return (await providerConnection(provider)) !== null;
}

/** Ollama's OpenAI-compatible API. */
const ollamaApiUrl = async () => new URL("/v1", await ollamaBase()).toString();

export async function languageModel(provider: string, model: string): Promise<LanguageModelV4> {
  if (!isProviderId(provider)) throw new Error(`Unknown provider ${provider}`);
  // Connected through its plan: the account's models, no key.
  if (isSubscriptionProviderId(provider) && (await isSubscriptionConnected(provider))) {
    const planned = await subscriptionLanguageModel(provider, model);
    if (!planned) throw new ProviderNotConfiguredError(provider);
    return planned;
  }
  const key = await apiKey(provider);
  if (provider === "ollama") {
    return createOpenAICompatible({ name: "ollama", baseURL: await ollamaApiUrl(), includeUsage: true })(model);
  }
  const baseURL = providerBaseUrl((await getSettings()).models.baseUrls, provider);
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: key, baseURL })(model);
    case "openai":
      return createOpenAI({ apiKey: key, baseURL })(model);
    case "deepseek":
      return createDeepSeek({ apiKey: key, baseURL })(model);
    case "moonshot":
      return createOpenAICompatible({ name: "moonshot", baseURL: baseURL!, apiKey: key, includeUsage: true })(model);
  }
}

/** The provider that embeds memory, journals and knowledge, chosen in Settings. */
export const embeddingProvider = async (): Promise<EmbeddingProvider> => (await getSettings()).memory.embeddingProvider;

/** Ollama's embedding model, through its OpenAI-compatible API; the built-in model has its own path (local-embeddings.ts). */
export async function ollamaEmbeddingModel(): Promise<EmbeddingModel> {
  return createOpenAICompatible({ name: "ollama", baseURL: await ollamaApiUrl() }).embeddingModel(
    EMBEDDING_PROFILES.ollama.model,
  );
}

/**
 * Whether `provider` can embed now, else what it lacks: the built-in model needs the worker to have loaded
 * it, Ollama a running server with the embedding model pulled.
 */
export type EmbeddingReadiness = "ready" | "local-loading" | "local-failed" | "ollama-unreachable" | "ollama-model-missing";

export async function embeddingReadiness(provider: EmbeddingProvider): Promise<EmbeddingReadiness> {
  if (provider === "local") {
    // A status of another model is from before an update: the worker has not loaded this one yet.
    const status = await localEmbeddingStatus();
    if (status?.model !== LOCAL_EMBEDDING_MODEL.id) return "local-loading";
    return status.state === "ready" ? "ready" : status.state === "failed" ? "local-failed" : "local-loading";
  }
  try {
    const res = await fetch(new URL("/api/tags", await ollamaBase()), { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return "ollama-unreachable";
    const { models } = (await res.json()) as { models: { name: string }[] };
    // Pulled without a tag, the model is listed as embeddinggemma:latest.
    const pulled = models.some((m) => m.name.split(":")[0] === EMBEDDING_PROFILES.ollama.model);
    return pulled ? "ready" : "ollama-model-missing";
  } catch {
    return "ollama-unreachable";
  }
}

/** Voice messages are transcribed by OpenAI only. */
export const TRANSCRIPTION_PROVIDER = "openai" satisfies ProviderId;

export async function transcriptionModel() {
  return createOpenAI({
    apiKey: await apiKey(TRANSCRIPTION_PROVIDER),
    baseURL: providerBaseUrl((await getSettings()).models.baseUrls, TRANSCRIPTION_PROVIDER),
  }).transcription("gpt-4o-mini-transcribe");
}

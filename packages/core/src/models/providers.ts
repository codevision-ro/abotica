import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { EmbeddingModel } from "ai";
import { UserError } from "@abotica/i18n";
import { isLocalProvider, isProviderId, isSubscriptionProviderId, type ProviderId } from "./catalog";
import { env } from "../infra/env";
import { getSettings } from "../platform/settings";
import { getSecret } from "../platform/vault";
import { isSubscriptionConnected, subscriptionLanguageModel } from "./subscriptions/connections";

/** The vault name of each provider's API key, set in Settings; null for a local server. */
export const PROVIDER_KEY_SECRET: Record<ProviderId, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  ollama: null,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

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
  if (isLocalProvider(provider)) return (await getSettings()).ollamaEnabled ? "local" : null;
  if (isSubscriptionProviderId(provider) && (await isSubscriptionConnected(provider))) return "plan";
  const name = PROVIDER_KEY_SECRET[provider];
  return name && (await getSecret(name)) ? "api-key" : null;
}

export async function isProviderConfigured(provider: ProviderId): Promise<boolean> {
  return (await providerConnection(provider)) !== null;
}

const ollamaBaseUrl = () => new URL("/v1", env().OLLAMA_BASE_URL).toString();

export async function languageModel(provider: string, model: string): Promise<LanguageModelV4> {
  if (!isProviderId(provider)) throw new Error(`Unknown provider ${provider}`);
  // Connected through its plan: the account's models, no key.
  if (isSubscriptionProviderId(provider) && (await isSubscriptionConnected(provider))) {
    const planned = await subscriptionLanguageModel(provider, model);
    if (!planned) throw new ProviderNotConfiguredError(provider);
    return planned;
  }
  const key = await apiKey(provider);
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: key })(model);
    case "openai":
      return createOpenAI({ apiKey: key })(model);
    case "deepseek":
      return createDeepSeek({ apiKey: key })(model);
    case "moonshot":
      return createOpenAICompatible({ name: "moonshot", baseURL: MOONSHOT_BASE_URL, apiKey: key, includeUsage: true })(
        model,
      );
    case "ollama":
      return createOpenAICompatible({ name: "ollama", baseURL: ollamaBaseUrl(), includeUsage: true })(model);
  }
}

const EMBEDDING_MODELS = {
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
} as const;

/** The provider that embeds memory, journals and knowledge (EMBEDDING_PROVIDER). */
export const embeddingProvider = (): "openai" | "ollama" => env().EMBEDDING_PROVIDER;

export async function embeddingModel(): Promise<{ model: EmbeddingModel; provider: "openai" | "ollama" }> {
  const provider = embeddingProvider();
  if (provider === "ollama") {
    return {
      provider,
      model: createOpenAICompatible({ name: "ollama", baseURL: ollamaBaseUrl() }).embeddingModel(EMBEDDING_MODELS.ollama),
    };
  }
  return { provider, model: createOpenAI({ apiKey: await apiKey("openai") }).embeddingModel(EMBEDDING_MODELS.openai) };
}

/** Voice messages are transcribed by OpenAI only. */
export const TRANSCRIPTION_PROVIDER = "openai" satisfies ProviderId;

export async function transcriptionModel() {
  return createOpenAI({ apiKey: await apiKey(TRANSCRIPTION_PROVIDER) }).transcription("gpt-4o-mini-transcribe");
}

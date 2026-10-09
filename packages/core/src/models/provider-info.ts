/**
 * The providers Abotica connects to, as data. Pure and client-safe: the settings schema and the forms
 * read it; catalog.ts adds the models and prices.
 */

export type ProviderInfo = {
  label: string;
  /** models.dev provider id: the model list and prices with an API key, model metadata with a plan. */
  catalogId: string | null;
  /** Runs on a local server: no key, no per-token cost. */
  local?: true;
  /**
   * The plan the provider can be connected through instead of an API key (one or the other):
   * the account then lists the models and calls cost nothing per token.
   */
  plan?: string;
};

export const PROVIDERS = {
  anthropic: { label: "Anthropic", catalogId: "anthropic" },
  openai: { label: "OpenAI", catalogId: "openai", plan: "ChatGPT" },
  deepseek: { label: "DeepSeek", catalogId: "deepseek" },
  moonshot: { label: "Kimi (Moonshot)", catalogId: "moonshotai" },
  ollama: { label: "Ollama", catalogId: null, local: true },
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return value in PROVIDERS;
}

/** Providers reached over the internet with an API key, whose address can be changed (a proxy, a region). */
export const CLOUD_PROVIDER_IDS = ["anthropic", "openai", "deepseek", "moonshot"] as const satisfies readonly ProviderId[];
export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

/** The address each cloud provider's SDK calls when Settings leaves it empty. */
export const DEFAULT_PROVIDER_BASE_URLS: Record<CloudProviderId, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.ai/v1",
};

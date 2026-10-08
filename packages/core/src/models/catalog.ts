import { redis } from "../infra/redis";
import { inputFromOllama } from "./input-modalities";
import { ollamaBase } from "./ollama";
import { isSubscriptionConnected, listSubscriptionModels } from "./subscriptions/connections";
import { type ModelsDevReasoningOption, type ReasoningSupport, supportFromModelsDev, supportFromOllama } from "./reasoning";

/** Model catalog and pricing from models.dev (USD per 1M tokens). */
const CATALOG_URL = "https://models.dev/api.json";
// Versioned: a cached entry from before a shape change is ignored, not misread.
const CACHE_KEY = "abotica:catalog:v5";
const CACHE_TTL_SECONDS = 24 * 3600;

type ProviderInfo = {
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

const info = (id: ProviderId): ProviderInfo => PROVIDERS[id];

/** Providers that can be connected through a plan (subscription) instead of an API key. */
export type SubscriptionProviderId = {
  [K in ProviderId]: (typeof PROVIDERS)[K] extends { plan: string } ? K : never;
}[ProviderId];

export const SUBSCRIPTION_PROVIDER_IDS = PROVIDER_IDS.filter((id): id is SubscriptionProviderId => Boolean(info(id).plan));

export function isSubscriptionProviderId(value: string): value is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDER_IDS as string[]).includes(value);
}

export const isLocalProvider = (id: ProviderId): boolean => Boolean(info(id).local);

export type CatalogModel = {
  id: string;
  name: string;
  provider: ProviderId;
  toolCall: boolean;
  /** What the model accepts for reasoning effort; `null` when it does not reason. */
  reasoning: ReasoningSupport | null;
  /** Input modalities ("text", "image", "pdf", "audio", "video"); `null` when unknown. */
  input: string[] | null;
  contextWindow: number | null;
  releaseDate: string | null;
  /** USD per 1M tokens; `cacheWrite` is the 5-minute write price where writes cost extra. */
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  /**
   * The provider's API price (USD per 1M tokens) even when a plan makes `cost` zero, so models compare by
   * what they consume; `null` for a local model or one models.dev does not price.
   */
  listPrice: { input: number; output: number } | null;
};

/** The provider's tool-capable model with the lowest input price (the provider connection test uses it). */
export function cheapestToolModel(catalog: CatalogModel[], provider: ProviderId): CatalogModel | undefined {
  return catalog
    .filter((m) => m.provider === provider && m.toolCall)
    .sort((a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY))[0];
}

type ModelsDevModel = {
  id: string;
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  release_date?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

type ModelsDev = Record<string, { models: Record<string, ModelsDevModel> }>;

async function fetchModelsDev(): Promise<ModelsDev> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
  return (await res.json()) as ModelsDev;
}

function fromModelsDev(m: ModelsDevModel, provider: ProviderId): CatalogModel {
  const { input, output, cache_read, cache_write } = m.cost ?? {};
  const priced = input !== undefined && output !== undefined;
  return {
    id: m.id,
    name: m.name,
    provider,
    toolCall: m.tool_call ?? false,
    reasoning: supportFromModelsDev(m.reasoning, m.reasoning_options),
    input: m.modalities?.input ?? null,
    contextWindow: m.limit?.context ?? null,
    releaseDate: m.release_date ?? null,
    cost: priced ? { input, output, cacheRead: cache_read, cacheWrite: cache_write } : null,
    listPrice: priced ? { input, output } : null,
  };
}

const textOutput = (m: ModelsDevModel) => !m.modalities?.output || m.modalities.output.includes("text");

/** Every text model of the providers reached with an API key, with prices. */
function apiKeyModels(data: ModelsDev, onPlan: Set<ProviderId>): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const provider of PROVIDER_IDS) {
    const { catalogId } = info(provider);
    if (!catalogId || onPlan.has(provider)) continue;
    for (const m of Object.values(data[catalogId]?.models ?? {})) {
      if (textOutput(m)) out.push(fromModelsDev(m, provider));
    }
  }
  return out;
}

const PLAN_COST = { input: 0, output: 0 };

/**
 * The models of each provider connected through its plan, as the account lists them. models.dev
 * fills in what the account does not say; calls cost nothing per token. Also returns which
 * providers are on their plan, so their API key models stay out of the catalog.
 */
async function planModels(data: ModelsDev | null): Promise<{ models: CatalogModel[]; onPlan: Set<ProviderId> }> {
  const models: CatalogModel[] = [];
  const onPlan = new Set<ProviderId>();
  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    if (!(await isSubscriptionConnected(provider))) continue;
    onPlan.add(provider);
    const known = data?.[info(provider).catalogId!]?.models ?? {};
    for (const m of await listSubscriptionModels(provider).catch(() => [])) {
      const base = known[m.id];
      models.push({
        ...(base
          ? fromModelsDev(base, provider)
          : { toolCall: true, reasoning: null, input: null, contextWindow: null, releaseDate: null, listPrice: null }),
        ...m,
        provider,
        cost: PLAN_COST,
      });
    }
  }
  return { models, onPlan };
}

type OllamaShow = Parameters<typeof supportFromOllama>[0] & Parameters<typeof inputFromOllama>[0];

/**
 * A local model's thinking support and input modalities from /api/show; a model that cannot be read
 * counts as not reasoning, with unknown input.
 */
async function ollamaDetails(base: string, model: string): Promise<Pick<CatalogModel, "reasoning" | "input">> {
  try {
    const res = await fetch(new URL("/api/show", base), {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { reasoning: null, input: null };
    const show = (await res.json()) as OllamaShow;
    return { reasoning: supportFromOllama(show), input: inputFromOllama(show) };
  } catch {
    return { reasoning: null, input: null };
  }
}

async function fetchOllama(): Promise<CatalogModel[]> {
  try {
    const base = await ollamaBase();
    const res = await fetch(new URL("/api/tags", base), { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models: { name: string }[] };
    // Embedding models cannot chat; keep them out of the model pickers.
    const chat = data.models.filter((m) => !/embed/i.test(m.name));
    return Promise.all(
      chat.map(async (m) => ({
        id: m.name,
        name: m.name,
        provider: "ollama" as const,
        toolCall: true,
        ...(await ollamaDetails(base, m.name)),
        contextWindow: null,
        releaseDate: null,
        cost: { input: 0, output: 0 },
        listPrice: null,
      })),
    );
  } catch {
    return [];
  }
}

export async function refreshCatalog(): Promise<CatalogModel[]> {
  const data = await fetchModelsDev();
  const plans = await planModels(data);
  const models = [...apiKeyModels(data, plans.onPlan), ...plans.models, ...(await fetchOllama())];
  await redis().set(CACHE_KEY, JSON.stringify(models), "EX", CACHE_TTL_SECONDS);
  return models;
}

export async function getCatalog(): Promise<CatalogModel[]> {
  const cached = await redis().get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as CatalogModel[];
  try {
    return await refreshCatalog();
  } catch {
    // models.dev unreachable: what the accounts and the local server list is still usable.
    return [...(await planModels(null)).models, ...(await fetchOllama())];
  }
}

/** How long a prompt cache entry lives; Anthropic bills a 1-hour write at twice the input price. */
export type CacheTtl = "5m" | "1h";

export async function estimateCost(
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number },
  cacheTtl: CacheTtl = "5m",
): Promise<number> {
  if (!isProviderId(provider) || isLocalProvider(provider)) return 0;
  const entry = (await getCatalog()).find((m) => m.provider === provider && m.id === model);
  if (!entry?.cost) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const cacheRate = entry.cost.cacheRead ?? entry.cost.input;
  const writeRate =
    provider === "anthropic" && cacheTtl === "1h" ? 2 * entry.cost.input : (entry.cost.cacheWrite ?? entry.cost.input);
  return (
    ((usage.inputTokens - cached - written) * entry.cost.input +
      cached * cacheRate +
      written * writeRate +
      usage.outputTokens * entry.cost.output) /
    1_000_000
  );
}

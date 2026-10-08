import "server-only";
import {
  availableProviders,
  type CatalogModel,
  getCatalog,
  getSettings,
  isProviderId,
  MIN_SUCCESS_RATE,
  type ModelRating,
  modelRunStats,
  PROVIDER_IDS,
  type ProviderConnection,
  providerConnection,
  PROVIDERS,
  type ProviderId,
  rateModel,
  RATING_WINDOW_DAYS,
} from "@abotica/core";
import { agents, db, type ModelRef } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { query } from "@/server/query";

export type ModelRatingRow = {
  key: string;
  provider: ProviderId;
  providerLabel: string;
  id: string;
  name: string;
  /** How its provider is connected; null when it is not (a model still set on an agent, say). */
  connection: ProviderConnection | null;
  /** In a default chain or on an agent, or it ran in the rating window. */
  inUse: boolean;
  rating: ModelRating;
};

const keyOf = (provider: string, model: string) => `${provider}:${model}`;

export type ModelRatings = {
  models: ModelRatingRow[];
  /** Days of runs the performance covers. */
  windowDays: number;
  /** Success rate (0 to 1) under which a model loses its recommendation. */
  minSuccessRate: number;
};

/**
 * The rating of every tool-capable model of the connected providers, plus any model still in use
 * elsewhere (a disconnected provider, an id typed by hand). Ordered by provider, then by consumption.
 */
export const listModelRatings = query(async (): Promise<ModelRatings> => {
  const [available, catalog, settings, agentRows, stats] = await Promise.all([
    availableProviders().catch(() => []),
    getCatalog().catch(() => [] as CatalogModel[]),
    getSettings(),
    db
      .select({ provider: agents.provider, model: agents.model, fallbacks: agents.fallbacks })
      .from(agents)
      .where(eq(agents.isTemplate, false)),
    modelRunStats(),
  ]);

  const configured: ModelRef[] = [
    ...settings.defaultModels,
    ...settings.orchestratorModels,
    ...settings.managerModels,
    ...agentRows.flatMap((a) => [
      ...(a.provider && a.model ? [{ provider: a.provider, model: a.model }] : []),
      ...a.fallbacks,
    ]),
  ];
  const inUse = new Set([...configured, ...stats].map((r) => keyOf(r.provider, r.model)));
  const statsBy = new Map(stats.map((s) => [keyOf(s.provider, s.model), s]));
  const connections = new Map(
    await Promise.all(PROVIDER_IDS.map(async (id) => [id, await providerConnection(id).catch(() => null)] as const)),
  );

  const models = new Map<string, Pick<CatalogModel, "provider" | "id" | "name" | "listPrice">>();
  for (const p of available) for (const m of p.models) models.set(keyOf(m.provider, m.id), m);
  for (const ref of [...configured, ...stats]) {
    const key = keyOf(ref.provider, ref.model);
    if (models.has(key) || !isProviderId(ref.provider)) continue;
    const known = catalog.find((m) => m.provider === ref.provider && m.id === ref.model);
    models.set(key, known ?? { provider: ref.provider, id: ref.model, name: ref.model, listPrice: null });
  }

  const rows = [...models.entries()].map(([key, m]) => ({
    key,
    provider: m.provider,
    providerLabel: PROVIDERS[m.provider].label,
    id: m.id,
    name: m.name,
    connection: connections.get(m.provider) ?? null,
    inUse: inUse.has(key),
    rating: rateModel(m.listPrice, statsBy.get(key)),
  }));
  // Unpriced models (local, unknown) after the priced ones of their provider.
  const level = (row: ModelRatingRow) => row.rating.consumption?.level ?? 6;
  rows.sort(
    (a, b) =>
      PROVIDER_IDS.indexOf(a.provider) - PROVIDER_IDS.indexOf(b.provider) ||
      level(a) - level(b) ||
      a.name.localeCompare(b.name),
  );
  return { models: rows, windowDays: RATING_WINDOW_DAYS, minSuccessRate: MIN_SUCCESS_RATE };
});

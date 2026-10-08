import "server-only";
import { embeddingReadiness, getReindexState, getSettings } from "@abotica/core";
import { query } from "@/server/query";

/** The embedding provider, whether each one could embed now, and the re-embedding in progress. */
export const getEmbeddingStatus = query(async () => {
  const [settings, reindex, local, openai, ollama] = await Promise.all([
    getSettings(),
    getReindexState(),
    embeddingReadiness("local"),
    embeddingReadiness("openai"),
    embeddingReadiness("ollama"),
  ]);
  return { provider: settings.embeddingProvider, readiness: { local, openai, ollama }, reindex };
});

export type EmbeddingStatus = Awaited<ReturnType<typeof getEmbeddingStatus>>;

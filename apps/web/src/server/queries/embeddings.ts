import "server-only";
import { embeddingReadiness, getReindexState, getSettings } from "@abotica/core";
import { query } from "@/server/query";

/** The embedding provider, whether each one could embed now, and the re-embedding in progress. */
export const getEmbeddingStatus = query(async () => {
  const [settings, reindex, local, ollama] = await Promise.all([
    getSettings(),
    getReindexState(),
    embeddingReadiness("local"),
    embeddingReadiness("ollama"),
  ]);
  return { provider: settings.memory.embeddingProvider, readiness: { local, ollama }, reindex };
});

export type EmbeddingStatus = Awaited<ReturnType<typeof getEmbeddingStatus>>;

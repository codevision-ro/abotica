import path from "node:path";
import {
  createRedis,
  type EmbeddingJob,
  embedLocal,
  env,
  getSettings,
  LOCAL_EMBEDDING_MODEL,
  QUEUE,
  registerLocalEmbedder,
  setLocalEmbeddingStatus,
} from "@abotica/core";
import { env as transformers, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { Worker } from "bullmq";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

/** Texts per forward pass: a batch is padded to its longest text, so a few at a time. */
const BATCH = 16;
/** How long an embedding waits for a model still loading before the caller goes on without vectors. */
const LOAD_WAIT_MS = 15_000;

let model: Promise<FeatureExtractionPipeline> | null = null;
let loaded = false;

/**
 * The built-in embedding model, loaded in the worker only (see models/local-embeddings.ts). The first load
 * downloads it (about 280 MB) to MODELS_DIR, a volume in the compose files; later ones read it from there.
 */
function load(): Promise<FeatureExtractionPipeline> {
  model ??= (async () => {
    await setLocalEmbeddingStatus({ state: "loading" });
    transformers.cacheDir = env().MODELS_DIR ?? path.resolve(process.cwd(), ".data/models");
    const started = Date.now();
    const extractor = await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL.id, {
      dtype: LOCAL_EMBEDDING_MODEL.dtype,
    });
    loaded = true;
    await setLocalEmbeddingStatus({ state: "ready" });
    console.log(`[embeddings] ${LOCAL_EMBEDDING_MODEL.id} loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return extractor;
  })().catch(async (error: unknown) => {
    // The next embedding tries again (a download cut off, no network at the first start).
    model = null;
    await setLocalEmbeddingStatus({ state: "failed", error: (error as Error).message }).catch(() => {});
    throw error;
  });
  return model;
}

async function ready(): Promise<FeatureExtractionPipeline> {
  if (loaded) return load();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The built-in embedding model is still loading")), LOAD_WAIT_MS);
  });
  try {
    return await Promise.race([load(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function embedInProcess(texts: string[]): Promise<number[][]> {
  const extractor = await ready();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // Mean pooling and unit length, as the model was trained; longer texts are cut at 512 tokens.
    const output = await extractor(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
    vectors.push(...(output.tolist() as number[][]));
  }
  return vectors;
}

/**
 * Embeds in this process from now on, and for the other processes through the embeddings queue. Loads
 * the model in the background when it is the provider, so the first run does not wait for the download.
 */
export function startEmbeddingsWorker() {
  registerLocalEmbedder(embedInProcess);
  void getSettings()
    .then(({ memory }) => (memory.embeddingProvider === "local" ? load() : null))
    .catch((error: unknown) => console.error("[embeddings] loading the built-in model failed:", error));
  return new Worker<EmbeddingJob>(QUEUE.embeddings, (job) => embedLocal(job.data.texts), {
    connection: createRedis(),
    concurrency: WORKER_CONCURRENCY.embeddings,
  });
}

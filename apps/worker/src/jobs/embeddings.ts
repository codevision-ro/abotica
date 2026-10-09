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
import { Worker } from "bullmq";
import { type EmbeddingModel, openEmbeddingModel } from "./embedding-model";
import { WORKER_CONCURRENCY } from "./worker-concurrency";

/**
 * Tokens per forward pass, padding included: texts of similar length go together, so a batch of short facts
 * holds many and a batch of 1,500-character knowledge chunks a few. Memory grows with the batch, not speed.
 */
const BATCH_TOKENS = 2048;
const MAX_BATCH = 32;
/** How long an embedding waits for a model still loading before the caller goes on without vectors. */
const LOAD_WAIT_MS = 15_000;

let model: Promise<EmbeddingModel> | null = null;
let loaded = false;

const status = (state: "loading" | "ready" | "failed", error?: string) =>
  setLocalEmbeddingStatus({ state, model: LOCAL_EMBEDDING_MODEL.id, ...(error && { error }) });

/**
 * The built-in embedding model, loaded in the worker only (see models/local-embeddings.ts). Read from
 * MODELS_DIR, where the installer downloaded it; a first load without it downloads it (about 330 MB).
 */
export function loadEmbeddingModel(): Promise<EmbeddingModel> {
  model ??= (async () => {
    await status("loading");
    const started = Date.now();
    const opened = await openEmbeddingModel(env().MODELS_DIR);
    loaded = true;
    await status("ready");
    console.log(`[embeddings] ${LOCAL_EMBEDDING_MODEL.id} loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return opened;
  })().catch(async (error: unknown) => {
    // The next embedding tries again (a download cut off, no network at the first start).
    model = null;
    await status("failed", (error as Error).message).catch(() => {});
    throw error;
  });
  return model;
}

async function ready(): Promise<EmbeddingModel> {
  if (loaded) return loadEmbeddingModel();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The built-in embedding model is still loading")), LOAD_WAIT_MS);
  });
  try {
    return await Promise.race([loadEmbeddingModel(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const unit = (v: number[]) => {
  const length = Math.hypot(...v);
  return length ? v.map((x) => x / length) : v;
};

/** `texts` already carry the model's prompts (embeddingInput). */
export async function embedInProcess(texts: string[]): Promise<number[][]> {
  const { tokenizer, model: weights } = await ready();
  const max = LOCAL_EMBEDDING_MODEL.maxTokens;
  const lengths = texts.map((text) => Math.min(max, tokenizer.encode(text).length));
  const order = texts.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  const vectors: number[][] = new Array(texts.length);
  for (let start = 0; start < order.length;) {
    // Sorted by length, the last text of a batch is its longest: the one every other is padded to.
    let end = start + 1;
    while (end < order.length && end - start < MAX_BATCH && lengths[order[end]!]! * (end + 1 - start) <= BATCH_TOKENS) {
      end++;
    }
    const batch = order.slice(start, end);
    const inputs = tokenizer(
      batch.map((i) => texts[i]!),
      { padding: true, truncation: true, max_length: max },
    );
    // The model pools and projects on its own (sentence_embedding); unit length, as it was trained.
    const { sentence_embedding } = (await weights(inputs)) as { sentence_embedding: { tolist(): number[][] } };
    sentence_embedding.tolist().forEach((vector, k) => (vectors[batch[k]!] = unit(vector)));
    start = end;
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
    .then(({ memory }) => (memory.embeddingProvider === "local" ? loadEmbeddingModel() : null))
    .catch((error: unknown) => console.error("[embeddings] loading the built-in model failed:", error));
  return new Worker<EmbeddingJob>(QUEUE.embeddings, (job) => embedLocal(job.data.texts), {
    connection: createRedis(),
    concurrency: WORKER_CONCURRENCY.embeddings,
  });
}

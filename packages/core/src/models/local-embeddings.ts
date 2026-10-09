import { EMBEDDING_DIMENSIONS } from "@abotica/db";
import { embeddingsQueue, embeddingsQueueEvents } from "../infra/queues";
import { redis } from "../infra/redis";

/**
 * The built-in embedding model (LOCAL_EMBEDDING_MODEL in embedding-profiles.ts) runs only in the worker. The
 * ONNX runtime is native and large, so the web server never loads it; the worker registers its embedder at
 * start (registerLocalEmbedder) and agent runs, which run there, embed in-process. Any other process (the web
 * app, a script) sends the texts to the worker on the embeddings queue and waits a few seconds; past that the
 * caller goes on as with any provider that does not answer: keyword search, a write without a vector.
 */
export type LocalEmbedder = (texts: string[]) => Promise<number[][]>;

let inProcess: LocalEmbedder | null = null;

/** The worker's embedder; set once at its start. */
export function registerLocalEmbedder(embedder: LocalEmbedder): void {
  inProcess = embedder;
}

/** How long a caller outside the worker waits for its vectors: a query takes milliseconds, a batch longer. */
const waitMs = (count: number) => 10_000 + 250 * count;

export async function embedLocal(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const vectors = inProcess ? await inProcess(texts) : await embedInWorker(texts);
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`The built-in embedding model returned vectors of another size than ${EMBEDDING_DIMENSIONS}`);
  }
  return vectors;
}

async function embedInWorker(texts: string[]): Promise<number[][]> {
  const events = await embeddingsQueueEvents();
  const job = await embeddingsQueue().add("embed", { texts }, { attempts: 1, removeOnComplete: true, removeOnFail: true });
  try {
    return (await job.waitUntilFinished(events, waitMs(texts.length))) as number[][];
  } catch (error) {
    // No worker, or one still loading the model: the caller went on without the vectors.
    await job.remove().catch(() => {});
    throw error;
  }
}

/**
 * Whether the worker has the model loaded; shared through Redis, since only the worker knows. `model` tells a
 * status from before an update, of the model it had then.
 */
export type LocalEmbeddingStatus = { state: "loading" | "ready" | "failed"; model: string; error?: string };

const STATUS_KEY = "abotica:embeddings:local";

export async function setLocalEmbeddingStatus(status: LocalEmbeddingStatus): Promise<void> {
  await redis().set(STATUS_KEY, JSON.stringify(status));
}

/** Null before the worker first loaded the model. */
export async function localEmbeddingStatus(): Promise<LocalEmbeddingStatus | null> {
  const raw = await redis().get(STATUS_KEY);
  return raw ? (JSON.parse(raw) as LocalEmbeddingStatus) : null;
}

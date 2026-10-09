/**
 * The embedding model of each provider and how its vectors are read. Pure, no server imports.
 *
 * Every number here is measured, not guessed: `pnpm --filter @abotica/worker eval:embeddings` embeds a
 * set of Romanian and English facts, questions and labeled pairs (apps/worker/scripts/embeddings-eval.json)
 * with each provider and prints these values. Vectors of two models cannot be compared, and each model
 * spreads its similarities differently (one puts unrelated text near 0.2, another near 0.6), so a
 * threshold holds for one model only. Changing a model or its prompts means a new `revision` (the stored
 * vectors are embedded again, see embedding-reindex.ts) and measuring again.
 */
import type { EmbeddingProvider } from "../settings/settings-schema";

/** A search query, or a text that is stored and searched (a memory, a journal, a knowledge chunk). */
export type EmbedKind = "query" | "document";

export type EmbeddingProfile = {
  /** The model's id at its provider. */
  model: string;
  /** Bumped when the vectors change for the same model (its prompts): the stored ones are embedded again. */
  revision: number;
  /** What precedes the text, as the model was trained: retrieval models embed queries and documents apart. */
  prompts: Record<EmbedKind, string>;
  /**
   * Cosine distance under which an entry is about the same thing as a new fact, which may restate or replace
   * it (memory-write-gate.ts). There is no distance for "the same fact": an update ("prefers phone calls over
   * email" after "prefers email over phone calls") sits as close as a paraphrase with every model measured.
   */
  relatedDistance: number;
  /**
   * Cosine similarity of a query to an entry that does not answer it, typically: search scores count from
   * here, so the keyword score weighs the same with every model (memory-ranking.ts).
   */
  unrelatedSimilarity: number;
  /** Cosine similarity under which an entry is not recalled into a run's prompt unprompted (memory-recall.ts). */
  recallSimilarity: number;
};

/**
 * EmbeddingGemma (Google, 308M parameters, 768 dimensions, 100+ languages): the best model measured on
 * Romanian and English (95% of questions answered first, against 85% for OpenAI's text-embedding-3-small,
 * 91% for text-embedding-3-large and 48% for nomic-embed-text), and the same weights run in the worker
 * (ONNX, int8) and in Ollama, so the two share their thresholds. Its prompts are the retrieval ones of its
 * model card.
 */
const EMBEDDING_GEMMA = {
  revision: 1,
  prompts: { query: "task: search result | query: ", document: "title: none | text: " },
  relatedDistance: 0.4,
  unrelatedSimilarity: 0.18,
  recallSimilarity: 0.35,
} satisfies Omit<EmbeddingProfile, "model">;

/**
 * The built-in model as the worker runs it: EmbeddingGemma's ONNX conversion, int8 weights (about 330 MB) on
 * the CPU through transformers.js. Its license is Google's Gemma Terms of Use: the installer and the worker
 * download it from Hugging Face, it is not shipped in the images. Not pinned to a revision: transformers.js
 * 4.3 looks for some files of a pinned one under the main revision, so it would need the network at every
 * start. Once downloaded it is read from the cache only, so a later change upstream reaches only a fresh
 * download.
 */
export const LOCAL_EMBEDDING_MODEL = {
  id: "onnx-community/embeddinggemma-300m-ONNX",
  /** int8: as good as the full weights on the evaluation set, a quarter of their size; fp16 is not supported. */
  dtype: "q8",
  /** Tokens per text the model reads; longer ones are cut. */
  maxTokens: 2048,
} as const;

export const EMBEDDING_PROFILES: Record<EmbeddingProvider, EmbeddingProfile> = {
  local: { model: LOCAL_EMBEDDING_MODEL.id, ...EMBEDDING_GEMMA },
  ollama: { model: "embeddinggemma", ...EMBEDDING_GEMMA },
};

/** What the stored vectors were embedded with; a different one means they are embedded again. */
export const embeddingFingerprint = (provider: EmbeddingProvider): string => {
  const { model, revision } = EMBEDDING_PROFILES[provider];
  return `${provider}/${model}#${revision}`;
};

/**
 * The vectors of installs from before the fingerprint was kept: the built-in model was
 * paraphrase-multilingual-mpnet-base-v2 and Ollama's nomic-embed-text. Installs on OpenAI's
 * text-embedding-3-small, measured below EmbeddingGemma and no longer offered, move to the built-in model.
 */
export const LEGACY_EMBEDDING_FINGERPRINTS: Record<EmbeddingProvider, string> = {
  local: "local/Xenova/paraphrase-multilingual-mpnet-base-v2",
  ollama: "ollama/nomic-embed-text",
};

/** `text` as the model of `provider` embeds it for `kind`. */
export const embeddingInput = (provider: EmbeddingProvider, kind: EmbedKind, text: string): string =>
  EMBEDDING_PROFILES[provider].prompts[kind] + text;

/**
 * A cosine similarity as a search score from 0 to 1, counted from the model's unrelated level: with every
 * model an unrelated entry scores near 0 and the keyword score keeps its weight (see fuseScores).
 */
export function vectorRelevance(similarity: number, unrelatedSimilarity: number): number {
  const score = (similarity - unrelatedSimilarity) / (1 - unrelatedSimilarity);
  return Math.min(1, Math.max(0, score));
}

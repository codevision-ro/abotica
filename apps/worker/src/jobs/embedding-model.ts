import path from "node:path";
import { LOCAL_EMBEDDING_MODEL } from "@abotica/core/embedding-profiles";
import {
  AutoModel,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressCallback,
  env as transformers,
} from "@huggingface/transformers";

export type EmbeddingModel = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };

/**
 * The built-in embedding model's files and runtime: downloaded once into `cacheDir` (MODELS_DIR, a volume in
 * the compose files; the installer fills it before the first start), then read from there. No Abotica
 * imports beyond the model's description, so the installer can run it without Postgres or Redis.
 */
export async function openEmbeddingModel(
  cacheDir: string | undefined,
  onProgress?: ProgressCallback,
): Promise<EmbeddingModel> {
  transformers.cacheDir = cacheDir ?? path.resolve(process.cwd(), ".data/models");
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(LOCAL_EMBEDDING_MODEL.id, { progress_callback: onProgress }),
    AutoModel.from_pretrained(LOCAL_EMBEDDING_MODEL.id, {
      dtype: LOCAL_EMBEDDING_MODEL.dtype,
      progress_callback: onProgress,
      // Without its memory arena ONNX Runtime gives back what a batch used: half the peak (about 1 GB
      // instead of 2 GB on long texts), at the same speed.
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
    }),
  ]);
  return { tokenizer, model };
}

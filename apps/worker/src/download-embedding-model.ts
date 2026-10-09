/**
 * Downloads the built-in embedding model into MODELS_DIR and checks that it loads, so the worker has it at
 * its first start; run by the installers before Abotica starts (docker compose run worker ...). Once it is
 * there it only loads it, in about a second. Exits 1 when it could not, and the worker downloads it at its
 * start instead.
 */
import { LOCAL_EMBEDDING_MODEL } from "@abotica/core/embedding-profiles";
import type { ProgressInfo } from "@huggingface/transformers";
import { openEmbeddingModel } from "./jobs/embedding-model";

/** When each large file started, and when it last printed its progress. */
const files = new Map<string, { started: number; last: number; done: boolean }>();
const EVERY_MS = 5_000;

/**
 * A line every few seconds per large file, and its last one, so a slow download shows it moves; files
 * already in the cache load within the first interval and print nothing.
 */
function progress(info: ProgressInfo) {
  if (info.status !== "progress" || info.total < 10_000_000) return;
  const now = Date.now();
  const file = files.get(info.file) ?? { started: now, last: now, done: false };
  files.set(info.file, file);
  const done = info.loaded >= info.total;
  if (file.done || (now - file.last < EVERY_MS && !(done && file.last > file.started))) return;
  file.last = now;
  file.done = done;
  console.log(`  ${info.file}: ${Math.round(info.loaded / 1e6)} of ${Math.round(info.total / 1e6)} MB`);
}

try {
  const started = Date.now();
  await openEmbeddingModel(process.env.MODELS_DIR, progress);
  console.log(`  ${LOCAL_EMBEDDING_MODEL.id} ready (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  process.exit(0);
} catch (error) {
  console.error(`  could not download ${LOCAL_EMBEDDING_MODEL.id}: ${(error as Error).message}`);
  process.exit(1);
}

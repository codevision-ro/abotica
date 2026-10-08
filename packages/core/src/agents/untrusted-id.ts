/**
 * Ids of the `<untrusted-data>` wrappers (see `untrusted.ts`). Server only: a replayed id is an HMAC
 * under the instance's secret, so data cannot predict the tag that closes its own block.
 */
import { createHmac, randomBytes } from "node:crypto";
import { env } from "../infra/env";

/** Derived so it survives restarts, like the tool approval secret. */
const markerSecret = () => createHmac("sha256", env().VAULT_KEY).update("untrusted-data-markers").digest();

/**
 * For wrappers rebuilt on every replay (tool results, keyed by their tool call id): the same seed
 * always gives the same id, so old results keep their bytes and the prompt cache holds.
 */
export const markerId = (seed: string): string =>
  createHmac("sha256", markerSecret()).update(seed).digest("hex").slice(0, 16);

/** For wrappers stored with their text (run inputs, delegation reports), which keep the id they got. */
export const newMarkerId = (): string => randomBytes(8).toString("hex");

/**
 * Write-only values of an MCP server (env, headers, OAuth client secret). A saved value leaves the
 * server only when it points into the vault (`{{secret:NAME}}`), which reveals a name, not a secret;
 * any other value is hidden, and the form sends `{ keep }` to leave it as saved. Pure and client-safe.
 */
import { UserError } from "@abotica/i18n";

/** A saved value as the form gets it: the text when it references the vault, otherwise null (hidden). */
export type StoredValue = string | null;

/** Keeps the saved value of the entry that had this key, so a hidden value survives a rename. */
export type KeepStored = { keep: string };

const SECRET_REFERENCE = /\{\{secret:[A-Z0-9_]+\}\}/;

/** Whether a value may be shown: it uses the vault, so whatever else it holds is not the secret. */
export const showsStoredValue = (value: string) => SECRET_REFERENCE.test(value);

export const redactStoredValue = (value: string): StoredValue => (showsStoredValue(value) ? value : null);

export function redactStoredRecord(record: Record<string, string>): Record<string, StoredValue> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactStoredValue(value)]));
}

/** The record to save: typed values as they are, kept ones taken from the saved record. */
export function resolveStoredRecord(
  submitted: Record<string, string | KeepStored>,
  saved: Record<string, string> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    const stored = saved?.[value.keep];
    // The server changed since the form was opened (or never existed): the value cannot be kept.
    if (stored === undefined) throw new UserError("mcp.errors.storedValueMissing", { key });
    out[key] = stored;
  }
  return out;
}

/** The OAuth client secret to save: a typed one, the saved one, or none. */
export function resolveStoredSecret(
  submitted: string | { keep: true } | null | undefined,
  saved: string | null,
): string | null {
  if (submitted == null) return null;
  if (typeof submitted === "string") return submitted;
  if (saved === null) throw new UserError("mcp.errors.storedValueMissing", { key: "client secret" });
  return saved;
}

/**
 * Timeouts a server may set for itself (Advanced in its form), in seconds; a server without one uses
 * the default. Here because the form checks them with the bounds the server action applies.
 */
export const MCP_TIMEOUTS = {
  /** Starting and the handshake: long enough for `npx -y` or `uvx` to download the server on a first start. */
  connectSec: { default: 90, min: 10, max: 600 },
  /** One tool call's answer. */
  callSec: { default: 120, min: 10, max: 3600 },
} as const;

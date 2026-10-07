/**
 * Replaces secrets in what a tool returns, so a token a command prints (`env`, a git trace) never
 * reaches the model, the run's history or the provider's logs. It catches accidents, not an agent
 * set on leaking one: an encoded or split secret goes through.
 */
export const REDACTED = "[redacted]";

/** Shorter values would be replaced inside ordinary text; real tokens are far longer. */
const MIN_SECRET_LENGTH = 8;

export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const active = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH))];
  return active.length ? (redact(value, active) as T) : value;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, REDACTED), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  }
  return value;
}

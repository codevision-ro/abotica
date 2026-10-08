/**
 * Replaces secrets in what a tool returns, so a token a command prints (`env`, a git trace) or an MCP
 * server echoes never reaches the model, the run's history or the provider's logs. It catches
 * accidents, not an agent set on leaking one: an encoded or split secret goes through.
 */
export const REDACTED = "[redacted]";

/** Shorter values would be replaced inside ordinary text; real tokens are far longer. */
const MIN_SECRET_LENGTH = 8;

/**
 * Well-known credential shapes, for values Abotica does not know (a key a server prints from its own
 * config). Specific prefixes only, so ordinary text is left alone; an Authorization scheme keeps its
 * name.
 */
const TOKEN_SHAPES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, `$1 ${REDACTED}`],
  [/\b(Authorization:\s*Basic)\s+[A-Za-z0-9+/]{12,}=*/gi, `$1 ${REDACTED}`],
];

/** Applies `replace` to every string of a result: strings, arrays and plain objects. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, replace)]));
  }
  return value;
}

/** The values worth replacing, longest first, so a secret that contains another goes whole. */
const knownValues = (secrets: Iterable<string>) =>
  [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);

const replaceKnown = (text: string, secrets: readonly string[]) =>
  secrets.reduce((out, secret) => out.replaceAll(secret, REDACTED), text);

const replaceShapes = (text: string) =>
  TOKEN_SHAPES.reduce((out, [shape, replacement]) => out.replace(shape, replacement), text);

/** `value` with the given secrets replaced; the value itself when none is long enough to look for. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const known = knownValues(secrets);
  return known.length ? (mapStrings(value, (text) => replaceKnown(text, known)) as T) : value;
}

/** Redacts with the secrets known so far, which grow as a run resolves more (an MCP server's env). */
export type SecretRedactor = {
  add(secrets: Iterable<string>): void;
  /** Known secrets first, then well-known token shapes. */
  redact<T>(value: T): T;
};

export function secretRedactor(secrets: Iterable<string> = []): SecretRedactor {
  const all = new Set<string>();
  let known: string[] = [];
  const add = (more: Iterable<string>) => {
    for (const secret of more) all.add(secret);
    known = knownValues(all);
  };
  add(secrets);
  return {
    add,
    redact: <T>(value: T) => mapStrings(value, (text) => replaceShapes(replaceKnown(text, known))) as T,
  };
}

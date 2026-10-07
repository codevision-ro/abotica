/**
 * What a failed model call means for the fallback chain: wait and call the same model again, move
 * to the next model, or stop because no model can take the prompt. Pure: reads only the error.
 */
import { UserError } from "@abotica/i18n";

/**
 * Why a model call failed. `context_overflow` is the prompt's fault, so another model would hit it
 * too; the other kinds belong to the model or its provider.
 */
export type ProviderErrorKind =
  "rate_limited" | "usage_limit" | "context_overflow" | "auth" | "not_found" | "transient" | "other";

/** Retries of the same model on a rate limit or a transient error, before moving down the chain. */
export const MAX_RETRIES = 3;
/** A longer Retry-After is not waited out: that time is better spent on the next model. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** First backoff without a Retry-After; it doubles on every retry (1-2 s, 2-4 s, 4-8 s with jitter). */
const BASE_DELAY_MS = 2_000;

/**
 * Error codes of limits that last far longer than a run: the ChatGPT plan's usage limit (sent as a 429,
 * see subscriptions/chatgpt-request.ts) and an OpenAI account out of credit (also a 429).
 */
const USAGE_LIMIT_CODES = ["subscription_sharing_usage_limit_exceeded", "insufficient_quota"];

/** Statuses a provider rejects an oversized prompt with; stream errors often carry none. */
const OVERFLOW_STATUSES = new Set([400, 413, 422]);

/**
 * Context window overflow, as the providers word it. The first group is OpenHands' provider-agnostic
 * list (sdk/llm/exceptions/classifier.py); the rest come from the providers Abotica connects. The
 * samples they match are in provider-errors.test.ts with their sources.
 */
const CONTEXT_OVERFLOW = [
  /contextwindowexceedederror/i,
  /prompt is too long/i,
  /input length and `?max_tokens`? exceed context limit/i,
  /please reduce the length of/i,
  /exceeds the available context size/i,
  /context length exceeded/i,
  /input exceeds the context window/i,
  /context window exceeds limit/i,
  // OpenAI and DeepSeek: "This model's maximum context length is N tokens", code context_length_exceeded.
  /maximum context length is \d+ tokens/i,
  /context_length_exceeded/,
  // Anthropic: a request over the size limit (HTTP 413).
  /request_too_large/,
  // Moonshot (Kimi).
  /exceeded model token limit/i,
  // Ollama: the llama.cpp runner and the MLX runner.
  /prompt is longer than the context length/i,
  /exceeds the model's maximum context length/i,
];

type ErrorRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is ErrorRecord => typeof value === "object" && value !== null;

/**
 * The error and its causes, outermost first. A stream error is a plain object ({ message, type, code,
 * statusCode }) kept as the cause of the error the fallback chain throws for it.
 */
function causeChain(error: unknown): ErrorRecord[] {
  const chain: ErrorRecord[] = [];
  for (let e = error; isRecord(e) && !chain.includes(e); e = e.cause) chain.push(e);
  return chain;
}

/** The first HTTP status along the chain, whether it is retryable, and the text that names the error. */
function factsOf(error: unknown): { status?: number; retryable: boolean; text: string } {
  let status: number | undefined;
  let retryable = false;
  const text: string[] = [];
  for (const e of causeChain(error)) {
    if (status === undefined && typeof e.statusCode === "number") status = e.statusCode;
    if (e.isRetryable === true) retryable = true;
    // Never the request: the prompt may well contain any of these words.
    for (const key of ["message", "code", "type", "responseBody"]) {
      const value = e[key];
      if (typeof value === "string" || typeof value === "number") text.push(String(value));
    }
  }
  return { status, retryable, text: text.join("\n") };
}

/** Network failures (ECONNREFUSED, fetch failed) for e.g. a stopped Ollama. */
function isNetworkError(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  return error instanceof TypeError || code === "ECONNREFUSED" || code === "ECONNRESET";
}

export function classifyProviderError(error: unknown): ProviderErrorKind {
  const { status, retryable, text } = factsOf(error);
  // Before the status: a usage limit comes as the same 429 as a short rate limit.
  if (USAGE_LIMIT_CODES.some((code) => text.includes(code))) return "usage_limit";
  if ((status === undefined || OVERFLOW_STATUSES.has(status)) && CONTEXT_OVERFLOW.some((p) => p.test(text))) {
    return "context_overflow";
  }
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if ((status !== undefined && status >= 500) || retryable || isNetworkError(error)) return "transient";
  return "other";
}

function header(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value.trim();
  }
  return undefined;
}

/**
 * The wait the provider asked for, in ms, from the response headers of the error or one of its causes:
 * `retry-after-ms` (whole milliseconds) first, then `Retry-After` as seconds or an HTTP date. Undefined
 * when neither carries a usable value. Same rules as Mastra's utils/retry-after.ts.
 */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  for (const e of causeChain(error)) {
    const ms = header(e.responseHeaders, "retry-after-ms");
    if (ms !== undefined && /^\d+$/.test(ms)) return Number(ms);
    const after = header(e.responseHeaders, "retry-after");
    if (after === undefined) continue;
    if (/^\d+$/.test(after)) return Number(after) * 1_000;
    // A fractional or signed number is neither form; Date.parse would read some of them as a year.
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(after)) continue;
    const at = Date.parse(after);
    if (Number.isFinite(at) && at > now) return at - now;
  }
  return undefined;
}

/**
 * How long to wait before calling the same model again after `retries` retries, or undefined to stop
 * retrying it: the error is not a rate limit or a transient failure, the retries are used up, or the
 * provider asked for a wait over MAX_RETRY_AFTER_MS. Without a Retry-After the wait is exponential
 * with jitter, so runs that hit the same limit together do not come back together.
 */
export function retryDelay(
  error: unknown,
  kind: ProviderErrorKind,
  retries: number,
  { now = Date.now(), random = Math.random }: { now?: number; random?: () => number } = {},
): number | undefined {
  if ((kind !== "rate_limited" && kind !== "transient") || retries >= MAX_RETRIES) return undefined;
  const asked = retryAfterMs(error, now);
  if (asked !== undefined) return asked <= MAX_RETRY_AFTER_MS ? asked : undefined;
  const ceiling = BASE_DELAY_MS * 2 ** retries;
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * The prompt does not fit the model's context window. No other model is tried, since every model in
 * the chain gets the same prompt; the runner can shorten the conversation and call again.
 */
export class ContextOverflowError extends UserError {
  constructor(options?: { cause?: unknown }) {
    super("errors.run.contextOverflow");
    this.cause = options?.cause;
  }
}

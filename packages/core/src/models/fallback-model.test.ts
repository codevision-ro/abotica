import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { isUserError } from "@abotica/i18n";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackModel } from "./fallback-model";
import { ContextOverflowError, MAX_RETRIES, MAX_RETRY_AFTER_MS } from "./provider-errors";
import { languageModel, ProviderNotConfiguredError } from "./providers";

// The chain's models come from the test; the real loaders read keys and settings from the database.
vi.mock("./providers", async () => {
  const { UserError } = await import("@abotica/i18n");
  class ProviderNotConfiguredError extends UserError {
    constructor(readonly provider: string) {
      super("errors.providerNotConfigured");
    }
  }
  return { languageModel: vi.fn(), ProviderNotConfiguredError };
});
vi.mock("./catalog", () => ({ getCatalog: async () => [] }));

const FIRST = { provider: "anthropic", model: "first" };
const SECOND = { provider: "openai", model: "second" };

const generated: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "ok" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

const apiError = (
  statusCode: number,
  message: string,
  extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {},
) => new APICallError({ message, url: "https://api.example.test/v1", requestBodyValues: {}, statusCode, ...extra });

const rateLimited = (retryAfter?: string) =>
  apiError(429, "Rate limit reached", {
    isRetryable: true,
    responseHeaders: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });

/** A model that throws the given errors on its first calls, then answers. */
function failing(...errors: unknown[]) {
  let calls = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const error = errors[calls++];
      if (error !== undefined) throw error;
      return generated;
    },
  });
}

/** A model that throws the same error on every call. */
const alwaysFailing = (error: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });

function useChain(models: Record<string, MockLanguageModelV4>) {
  vi.mocked(languageModel).mockImplementation(async (provider, model) => models[`${provider}/${model}`]!);
}

function fallbackModel(chain = [FIRST, SECOND]) {
  const onFallback = vi.fn();
  const onRetry = vi.fn();
  return { model: new FallbackModel(chain, { onFallback, onRetry }), onFallback, onRetry };
}

const call = (abortSignal?: AbortSignal): LanguageModelV4CallOptions => ({ prompt: [], abortSignal });

/** Settles the promise into a value, so a rejection is never left unhandled while timers advance. */
const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(languageModel).mockReset();
});

describe("FallbackModel backoff", () => {
  it("retries a 429 on the same model after its Retry-After, without falling back", async () => {
    const first = failing(rateLimited("2"));
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();

    const result = settled(model.doGenerate(call()));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(first.doGenerateCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).value?.content).toEqual(generated.content);
    expect(first.doGenerateCalls).toHaveLength(2);
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({
      model: FIRST,
      kind: "rate_limited",
      error: "Rate limit reached",
      attempt: 1,
      maxRetries: MAX_RETRIES,
      delayMs: 2_000,
    });
    expect(onFallback).not.toHaveBeenCalled();
    expect(model.lastServed).toEqual(FIRST);
  });

  it("falls back at once when Retry-After is over the cap", async () => {
    const first = failing(rateLimited(String(MAX_RETRY_AFTER_MS / 1_000 + 30)));
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();

    await model.doGenerate(call());

    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledExactlyOnceWith({
      from: FIRST,
      to: SECOND,
      error: "Rate limit reached",
      kind: "rate_limited",
      retries: 0,
      waitedMs: 0,
    });
    expect(model.lastServed).toEqual(SECOND);
  });

  it("falls back at once on a ChatGPT plan usage limit", async () => {
    const usageLimit = apiError(429, "Usage limit reached", {
      isRetryable: true,
      responseBody:
        '{"error":{"message":"Usage limit reached","code":"subscription_sharing_usage_limit_exceeded","param":null}}',
    });
    const first = failing(usageLimit);
    const second = failing();
    useChain({ "openai/second": first, "anthropic/first": second });
    const { model, onFallback, onRetry } = fallbackModel([SECOND, FIRST]);

    await model.doGenerate(call());

    expect(first.doGenerateCalls).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ kind: "usage_limit", retries: 0, waitedMs: 0 }));
  });

  it("fails a one-model chain that stays rate limited after the retries, saying so", async () => {
    const only = alwaysFailing(rateLimited("1"));
    useChain({ "anthropic/first": only });
    const { model, onFallback, onRetry } = fallbackModel([FIRST]);

    const result = settled(model.doGenerate(call()));
    await vi.runAllTimersAsync();
    const { error } = await result;

    expect(only.doGenerateCalls).toHaveLength(1 + MAX_RETRIES);
    expect(onRetry).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(onRetry.mock.calls.map(([e]) => e.attempt)).toEqual([1, 2, 3]);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ from: FIRST, to: null, kind: "rate_limited", retries: MAX_RETRIES, waitedMs: 3_000 }),
    );
    expect(isUserError(error) && error.key).toBe("errors.allProvidersRateLimited");
    expect((error as Error).message).toContain("rate limited");
    expect((error as Error).message).toContain("anthropic/first: Rate limit reached");
  });

  it("retries a transient error with exponential backoff, then falls back", async () => {
    const first = alwaysFailing(apiError(503, "Service unavailable", { isRetryable: true }));
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const result = settled(model.doGenerate(call()));
    await vi.runAllTimersAsync();

    expect((await result).error).toBeUndefined();
    expect(onRetry.mock.calls.map(([e]) => e.delayMs)).toEqual([1_000, 2_000, 4_000]);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "transient", retries: MAX_RETRIES, waitedMs: 7_000 }),
    );
    expect(second.doGenerateCalls).toHaveLength(1);
  });

  it("ends the wait when the run is aborted, without falling back", async () => {
    const first = failing(rateLimited("20"));
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();
    const controller = new AbortController();
    const reason = new Error("Cancelled");

    const result = settled(model.doGenerate(call(controller.signal)));
    await vi.waitFor(() => expect(onRetry).toHaveBeenCalled());
    controller.abort(reason);

    expect((await result).error).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("does not treat an abort during the call as a reason to fall back", async () => {
    const controller = new AbortController();
    const first = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      },
    });
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback } = fallbackModel();

    await expect(model.doGenerate(call(controller.signal))).rejects.toThrow("This operation was aborted");
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("FallbackModel errors", () => {
  it("throws ContextOverflowError without trying the next model", async () => {
    const overflow = apiError(400, "prompt is too long: 274468 tokens > 200000 maximum");
    const first = failing(overflow);
    const second = failing();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();

    const error = await model.doGenerate(call()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).toMatchObject({ key: "errors.run.contextOverflow", cause: overflow });
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("falls back from a provider that is not connected", async () => {
    const second = failing();
    vi.mocked(languageModel).mockImplementation(async (provider) => {
      if (provider === "anthropic") throw new ProviderNotConfiguredError(provider);
      return second;
    });
    const { model, onFallback } = fallbackModel();

    await model.doGenerate(call());

    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ from: FIRST, kind: "auth", retries: 0 }));
    expect(model.lastServed).toEqual(SECOND);
  });

  it("rethrows an error no other model would avoid", async () => {
    const invalid = apiError(400, "messages: text content blocks must be non-empty");
    const second = failing();
    useChain({ "anthropic/first": failing(invalid), "openai/second": second });
    const { model, onFallback } = fallbackModel();

    await expect(model.doGenerate(call())).rejects.toBe(invalid);
    expect(second.doGenerateCalls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("FallbackModel streams", () => {
  const streamOf = (...parts: LanguageModelV4StreamPart[]) => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  });

  async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>) {
    const parts: LanguageModelV4StreamPart[] = [];
    for (const reader = stream.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) return parts;
      parts.push(value);
    }
  }

  it("retries a 429 sent inside the stream like a 429 response", async () => {
    // Anthropic's stream error as the AI SDK provider emits it: the status is inferred from the type.
    const streamError = { message: "Rate limited", type: "rate_limit_error", statusCode: 429, isRetryable: true };
    let calls = 0;
    const first = new MockLanguageModelV4({
      doStream: async () =>
        calls++ === 0
          ? streamOf({ type: "stream-start", warnings: [] }, { type: "error", error: streamError })
          : streamOf({ type: "stream-start", warnings: [] }, { type: "text-start", id: "1" }),
    });
    const second = new MockLanguageModelV4();
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback, onRetry } = fallbackModel();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const result = settled(model.doStream(call()));
    await vi.runAllTimersAsync();
    const { value } = await result;

    expect(onRetry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: FIRST, kind: "rate_limited", error: "Rate limited", delayMs: 1_000 }),
    );
    expect(onFallback).not.toHaveBeenCalled();
    expect(second.doStreamCalls).toHaveLength(0);
    expect((await readAll(value!.stream)).map((p) => p.type)).toEqual(["stream-start", "text-start"]);
  });

  it("keeps falling back on any other error sent before the first output", async () => {
    const first = new MockLanguageModelV4({
      doStream: async () => streamOf({ type: "error", error: { message: "Something broke" } }),
    });
    const second = new MockLanguageModelV4({ doStream: async () => streamOf({ type: "text-start", id: "1" }) });
    useChain({ "anthropic/first": first, "openai/second": second });
    const { model, onFallback } = fallbackModel();

    await model.doStream(call());

    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ kind: "other", error: "Something broke" }));
    expect(model.lastServed).toEqual(SECOND);
  });
});

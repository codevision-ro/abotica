import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { terminalResponse } from "./subscriptions/chatgpt-request";
import {
  classifyProviderError,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  type ProviderErrorKind,
  retryAfterMs,
  retryDelay,
} from "./provider-errors";

/** An error as the AI SDK providers throw it for an HTTP error response. */
const apiError = (
  statusCode: number | undefined,
  message: string,
  extra: { responseBody?: string; responseHeaders?: Record<string, string>; isRetryable?: boolean } = {},
) => new APICallError({ message, url: "https://api.example.test/v1", requestBodyValues: {}, statusCode, ...extra });

/** An error sent inside the stream, wrapped as the fallback chain wraps it (EarlyStreamError). */
const inStream = (error: unknown) => new Error("stream error", { cause: error });

const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("classifyProviderError: context overflow", () => {
  // Real provider messages, verbatim except for token counts where noted. Sources:
  // - LibreChat agents, src/utils/__tests__/fixtures/contextOverflowSignatures.ts (captured from live
  //   over-limit requests, commit 97b2db3): Anthropic, OpenAI Chat Completions, DeepSeek.
  // - OpenHands software-agent-sdk, tests/sdk/llm/test_exception_classifier.py (commit 69e2688):
  //   the OpenAI Responses wording and the llama.cpp server wording.
  // - openclaw, src/agents/failover/failover-classification.overflow.cases.ts and
  //   packages/ai/src/utils/overflow.test.ts (commit a6c143f): Moonshot (Kimi), Anthropic's max_tokens sum.
  // - Ollama, ollama/ollama at f9f4af6: llm/llama_server.go (HTTP 400) and mlxrunner/pipeline.go.
  // - Anthropic's errors page (platform.claude.com/docs/en/api/errors): the 413 request_too_large type,
  //   its description used as the message, and the error envelope.
  // The response bodies follow each provider's error envelope as the AI SDK provider parses it.
  const fixtures: [string, APICallError][] = [
    [
      "Anthropic",
      apiError(400, "prompt is too long: 274468 tokens > 200000 maximum", {
        responseBody:
          '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 274468 tokens > 200000 maximum"},"request_id":"req_test"}',
      }),
    ],
    [
      "Anthropic, input plus max_tokens",
      apiError(400, "input length and `max_tokens` exceed context limit: 176312 + 32000 > 200000"),
    ],
    [
      "Anthropic, request over the size limit",
      apiError(413, "Request exceeds the maximum allowed number of bytes.", {
        responseBody:
          '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}',
      }),
    ],
    [
      "OpenAI Chat Completions",
      apiError(
        400,
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 149767 tokens. Please reduce the length of the messages.",
        {
          responseBody:
            '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 149767 tokens. Please reduce the length of the messages.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
        },
      ),
    ],
    [
      "OpenAI Responses",
      apiError(400, "Your input exceeds the context window of this model. Please adjust your input and try again."),
    ],
    [
      "DeepSeek",
      apiError(
        400,
        "This model's maximum context length is 1048565 tokens. However, you requested 1179668 tokens (1179652 in the messages, 16 in the completion).",
        {
          responseBody:
            '{"error":{"message":"This model\'s maximum context length is 1048565 tokens. However, you requested 1179668 tokens (1179652 in the messages, 16 in the completion).","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
        },
      ),
    ],
    [
      "Moonshot (Kimi)",
      apiError(400, "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)"),
    ],
    [
      "Ollama, llama.cpp runner",
      apiError(
        400,
        "the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length",
      ),
    ],
    [
      "Ollama, MLX runner",
      apiError(400, "input length (40000 tokens) exceeds the model's maximum context length (32768 tokens)"),
    ],
    [
      "llama.cpp server",
      apiError(
        400,
        "OpenAIException - request (138229 tokens) exceeds the available context size (133376 tokens), try increasing it",
      ),
    ],
  ];

  it.each(fixtures)("recognizes %s", (_, error) => {
    expect(classifyProviderError(error)).toBe("context_overflow");
  });

  it("recognizes an overflow sent inside the stream, with or without a status", () => {
    // OpenAI stream errors carry the status the provider derives from the code (400 for context_length).
    const openai = {
      message: "Your input exceeds the context window of this model.",
      code: "context_length_exceeded",
      statusCode: 400,
    };
    expect(classifyProviderError(inStream(openai))).toBe("context_overflow");
    // OpenAI-compatible providers (Moonshot, Ollama) pass the raw error object, without a status.
    const raw = { message: "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)" };
    expect(classifyProviderError(inStream(raw))).toBe("context_overflow");
  });

  it("does not read overflow wording in a rate limit or a server error", () => {
    // OpenAI rejects a request over the tokens-per-minute bucket as a 429 (LibreChat fixtures).
    const tpm = apiError(
      429,
      "Request too large for gpt-5-nano in organization org-test on tokens per min (TPM): Limit 200000, Requested 480002. The input or output tokens must be reduced in order to run successfully.",
      { isRetryable: true },
    );
    expect(classifyProviderError(tpm)).toBe("rate_limited");
    expect(classifyProviderError(apiError(500, "context length exceeded", { isRetryable: true }))).toBe("transient");
  });

  it("leaves other bad requests alone", () => {
    expect(classifyProviderError(apiError(400, "messages: text content blocks must be non-empty"))).toBe("other");
  });
});

describe("classifyProviderError", () => {
  it("tells a ChatGPT plan usage limit from a rate limit, though both are 429", async () => {
    // The body the plan's terminal error event becomes (subscriptions/chatgpt-request.ts).
    const response = terminalResponse({
      type: "error",
      code: "subscription_sharing_usage_limit_exceeded",
      message: "Usage limit reached",
    })!;
    const error = apiError(response.status, "Usage limit reached", {
      responseBody: await response.text(),
      isRetryable: true,
    });
    expect(response.status).toBe(429);
    expect(classifyProviderError(error)).toBe("usage_limit");
    expect(classifyProviderError(apiError(429, "Rate limit reached", { isRetryable: true }))).toBe("rate_limited");
  });

  it("treats an OpenAI account out of credit as a usage limit", () => {
    const body =
      '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}';
    expect(classifyProviderError(apiError(429, "You exceeded your current quota.", { responseBody: body }))).toBe(
      "usage_limit",
    );
  });

  it.each<[number, ProviderErrorKind]>([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [500, "transient"],
    [503, "transient"],
    [529, "transient"],
  ])("classifies HTTP %i as %s", (status, kind) => {
    expect(classifyProviderError(apiError(status, "failed"))).toBe(kind);
  });

  it("classifies a 429 sent inside the stream like a 429 response", () => {
    // Anthropic's stream error, with the status the AI SDK provider infers from its type.
    const anthropic = { message: "Rate limited", type: "rate_limit_error", statusCode: 429, isRetryable: true };
    expect(classifyProviderError(inStream(anthropic))).toBe("rate_limited");
    expect(classifyProviderError(inStream({ message: "Overloaded", type: "overloaded_error", statusCode: 529 }))).toBe(
      "transient",
    );
  });

  it("treats retryable and network failures as transient", () => {
    expect(classifyProviderError(apiError(undefined, "Cannot connect to API", { isRetryable: true }))).toBe("transient");
    expect(classifyProviderError(apiError(408, "Request timeout", { isRetryable: true }))).toBe("transient");
    expect(classifyProviderError(new TypeError("fetch failed"))).toBe("transient");
    expect(classifyProviderError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(
      "transient",
    );
  });

  it("gives anything else, an abort included, no provider meaning", () => {
    expect(classifyProviderError(new DOMException("This operation was aborted", "AbortError"))).toBe("other");
    expect(classifyProviderError(new Error("boom"))).toBe("other");
    expect(classifyProviderError("boom")).toBe("other");
    expect(classifyProviderError(null)).toBe("other");
  });

  it("does not loop on a cause cycle", () => {
    const a: Error = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyProviderError(a)).toBe("other");
  });
});

describe("retryAfterMs", () => {
  const withHeaders = (responseHeaders: Record<string, string>) => apiError(429, "Rate limited", { responseHeaders });

  it("reads retry-after-ms before Retry-After", () => {
    expect(retryAfterMs(withHeaders({ "retry-after-ms": "1500", "retry-after": "9" }), NOW)).toBe(1_500);
  });

  it("reads Retry-After as seconds or as an HTTP date", () => {
    expect(retryAfterMs(withHeaders({ "retry-after": "2" }), NOW)).toBe(2_000);
    expect(retryAfterMs(withHeaders({ "Retry-After": " 3 " }), NOW)).toBe(3_000);
    expect(retryAfterMs(withHeaders({ "retry-after": new Date(NOW + 4_000).toUTCString() }), NOW)).toBe(4_000);
  });

  it("ignores values it cannot read and dates in the past", () => {
    expect(retryAfterMs(withHeaders({ "retry-after-ms": "1.5", "retry-after": "2" }), NOW)).toBe(2_000);
    expect(retryAfterMs(withHeaders({ "retry-after": "1.5" }), NOW)).toBeUndefined();
    expect(retryAfterMs(withHeaders({ "retry-after": "-1" }), NOW)).toBeUndefined();
    expect(retryAfterMs(withHeaders({ "retry-after": "soon" }), NOW)).toBeUndefined();
    expect(retryAfterMs(withHeaders({ "retry-after": new Date(NOW - 1_000).toUTCString() }), NOW)).toBeUndefined();
    expect(retryAfterMs(withHeaders({}), NOW)).toBeUndefined();
    expect(retryAfterMs(new Error("no headers"), NOW)).toBeUndefined();
  });

  it("finds the headers on a cause", () => {
    expect(retryAfterMs(new Error("wrapped", { cause: withHeaders({ "retry-after": "5" }) }), NOW)).toBe(5_000);
  });
});

describe("retryDelay", () => {
  const options = { now: NOW, random: () => 0.5 };
  const limited = (retryAfter?: string) =>
    apiError(429, "Rate limited", { responseHeaders: retryAfter ? { "retry-after": retryAfter } : {} });

  it("waits what the provider asked for, up to the cap", () => {
    expect(retryDelay(limited("2"), "rate_limited", 0, options)).toBe(2_000);
    expect(retryDelay(limited(String(MAX_RETRY_AFTER_MS / 1_000)), "rate_limited", 0, options)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("does not wait out a Retry-After over the cap", () => {
    expect(retryDelay(limited(String(MAX_RETRY_AFTER_MS / 1_000 + 1)), "rate_limited", 0, options)).toBeUndefined();
    expect(retryDelay(limited("120"), "transient", 0, options)).toBeUndefined();
  });

  it("backs off exponentially with jitter without a Retry-After", () => {
    expect([0, 1, 2].map((n) => retryDelay(limited(), "rate_limited", n, { now: NOW, random: () => 0 }))).toEqual([
      1_000, 2_000, 4_000,
    ]);
    expect([0, 1, 2].map((n) => retryDelay(limited(), "transient", n, { now: NOW, random: () => 1 }))).toEqual([
      2_000, 4_000, 8_000,
    ]);
    expect(retryDelay(limited(), "rate_limited", 0, options)).toBe(1_500);
  });

  it(`stops after ${MAX_RETRIES} retries`, () => {
    expect(retryDelay(limited("1"), "rate_limited", MAX_RETRIES - 1, options)).toBe(1_000);
    expect(retryDelay(limited("1"), "rate_limited", MAX_RETRIES, options)).toBeUndefined();
  });

  it.each<ProviderErrorKind>(["usage_limit", "context_overflow", "auth", "not_found", "other"])(
    "does not retry %s",
    (kind) => {
      expect(retryDelay(limited("1"), kind, 0, options)).toBeUndefined();
    },
  );
});

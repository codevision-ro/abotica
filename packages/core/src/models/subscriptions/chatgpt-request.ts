/**
 * Adapts the AI SDK's Responses API requests to what ChatGPT plan usage accepts (preview):
 * stateless and streamed only, without sampling and bookkeeping fields, no system role items.
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */

type Body = Record<string, unknown>;

/** Fields the plan route rejects; the AI SDK sets some of them from call options. */
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "previous_response_id",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

/** System items are refused; developer messages carry the same instructions. */
function withoutSystemItems(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item: Body) => (item?.role === "system" ? { ...item, role: "developer" } : item));
}

export function toPlanRequest(body: Body): Body {
  const next: Body = { ...body, store: false, stream: true, input: withoutSystemItems(body.input) };
  for (const field of UNSUPPORTED_FIELDS) delete next[field];
  return next;
}

/** HTTP statuses for the plan's error codes, so retries and fallbacks treat them as the route would. */
const STATUS_BY_CODE: Record<string, number> = {
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_unsupported_capability: 400,
};

type ResponseError = { code?: string | null; message?: string; param?: string | null };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const errorResponse = (error: ResponseError | null | undefined) =>
  json(STATUS_BY_CODE[error?.code ?? ""] ?? 500, {
    error: { message: error?.message ?? "The response failed", code: error?.code ?? null, param: error?.param ?? null },
  });

/**
 * The HTTP response a terminal stream event stands for; null for every other event. The plan route
 * ends with an empty `output`, so the items finished during the stream (`items`) fill it in.
 */
export function terminalResponse(event: Body, items: unknown[] = []): Response | null {
  switch (event.type) {
    case "response.completed":
    case "response.incomplete": {
      const response = event.response as Body;
      const output = Array.isArray(response.output) && response.output.length ? response.output : items;
      return json(200, { ...response, output });
    }
    case "response.failed":
      return errorResponse((event.response as { error?: ResponseError } | undefined)?.error);
    case "error":
      return errorResponse(event as ResponseError);
    default:
      return null;
  }
}

/**
 * Reads a Responses event stream up to its terminal event and answers with that response as JSON,
 * which is what a non-streaming call expects. The plan route only streams.
 */
export async function finalResponse(res: Response): Promise<Response> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const items: unknown[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        buffer = buffer.slice(end + 2);
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as Body;
        if (event.type === "response.output_item.done") items[event.output_index as number] = event.item;
        const terminal = terminalResponse(event, items.filter(Boolean));
        if (terminal) return terminal;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return errorResponse({ code: "stream_incomplete", message: "The stream ended before the response completed" });
}

const isResponsesCall = (url: string, init?: RequestInit) =>
  init?.method === "POST" && typeof init.body === "string" && new URL(url).pathname.endsWith("/responses");

/** `fetch` for the OpenAI provider that sends every Responses call in the form the plan route takes. */
export const planFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!isResponsesCall(url, init)) return fetch(input, init);
  const body = JSON.parse(init!.body as string) as Body;
  const res = await fetch(input, { ...init, body: JSON.stringify(toPlanRequest(body)) });
  if (body.stream === true || !res.ok || !res.body) return res;
  return finalResponse(res);
};

import { describe, expect, it } from "vitest";
import { finalResponse, planHeaders, terminalResponse, toPlanRequest } from "./chatgpt-request";

const sse = (...events: object[]) =>
  new Response(events.map((e) => `event: x\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("toPlanRequest", () => {
  it("streams statelessly and drops the fields the plan route rejects", () => {
    const body = toPlanRequest({
      model: "m",
      input: [],
      stream: false,
      store: true,
      temperature: 0.2,
      top_p: 1,
      max_output_tokens: 5,
      previous_response_id: "r",
      user: "u",
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "f" }],
    });
    expect(body).toEqual({
      model: "m",
      input: [],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "f" }],
    });
  });

  it("turns system items into developer messages", () => {
    const body = toPlanRequest({
      input: [
        { role: "system", content: "rules" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    expect(body.input).toEqual([
      { role: "developer", content: "rules" },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });
});

describe("finalResponse", () => {
  it("answers with the completed response", async () => {
    const res = await finalResponse(
      sse(
        { type: "response.created", response: { id: "r", status: "in_progress" } },
        { type: "response.output_text.delta", delta: "O" },
        { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "r", status: "completed", output: [] });
  });

  it("fills an empty final output with the items finished during the stream", async () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
    const call = { type: "function_call", call_id: "c", name: "f", arguments: "{}" };
    const res = await finalResponse(
      sse(
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
      ),
    );
    expect((await res.json()).output).toEqual([message, call]);
  });

  it("maps a failed response to the status of its plan error", async () => {
    const res = await finalResponse(
      sse({
        type: "response.failed",
        response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
      }),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { message: "limit", code: "subscription_sharing_usage_limit_exceeded", param: null },
    });
  });

  it("reports a stream that ends without a terminal event", async () => {
    const res = await finalResponse(sse({ type: "response.created", response: { id: "r" } }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("stream_incomplete");
  });

  it("ignores events that do not end the response", () => {
    expect(terminalResponse({ type: "response.output_text.delta" })).toBeNull();
  });
});

describe("planHeaders", () => {
  it("routes the prompt cache by the conversation's key, as ChatGPT takes it from session-id", () => {
    const headers = planHeaders({ prompt_cache_key: "conv-1" }, { authorization: "Bearer t" });
    expect(headers.get("session-id")).toBe("conv-1");
    expect(headers.get("thread-id")).toBe("conv-1");
    expect(headers.get("authorization")).toBe("Bearer t");
  });

  it("adds nothing without a key", () => {
    const headers = planHeaders({}, { authorization: "Bearer t" });
    expect(headers.has("session-id")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer t");
  });
});

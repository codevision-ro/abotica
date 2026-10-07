import { generateText, isStepCount, tool, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deferTools, rankTools, TOOL_SEARCH, toolsUsedIn } from "./tool-loading";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const echo = (description: string) => tool({ description, inputSchema: z.object({}), execute: async () => description });

describe("rankTools", () => {
  const tools = [
    { name: "scrapling__get", description: "Fetch a page over HTTP" },
    { name: "scrapling__fetch", description: "Fetch a page in a browser" },
    { name: "obscura__browser_click", description: "Click an element" },
  ];

  it("puts exact names first, in the order asked", () => {
    expect(rankTools("obscura__browser_click, scrapling__get", tools).slice(0, 2)).toEqual([
      "obscura__browser_click",
      "scrapling__get",
    ]);
  });

  it("loads only the named tools, not their neighbours", () => {
    expect(rankTools("scrapling__get", tools)).toEqual(["scrapling__get"]);
  });

  it("ranks keyword matches, name words above description words", () => {
    expect(rankTools("browser", tools)).toEqual(["obscura__browser_click", "scrapling__fetch"]);
    expect(rankTools("scrapling", tools)).toEqual(["scrapling__get", "scrapling__fetch"]);
    expect(rankTools("nothing", tools)).toEqual([]);
  });
});

describe("toolsUsedIn", () => {
  it("collects called tools and the ones tool_search loaded", () => {
    const messages = [
      {
        id: "1",
        role: "assistant",
        parts: [
          { type: "tool-memory_search", toolCallId: "a", state: "output-available", input: {}, output: [] },
          {
            type: "dynamic-tool",
            toolName: "scrapling__get",
            toolCallId: "b",
            state: "output-available",
            input: {},
            output: "",
          },
          {
            type: `tool-${TOOL_SEARCH}`,
            toolCallId: "c",
            state: "output-available",
            input: { query: "click" },
            output: { tools: [{ name: "obscura__browser_click" }] },
          },
          { type: "text", text: "done" },
        ],
      },
    ] as UIMessage[];
    expect([...toolsUsedIn(messages)].sort()).toEqual(
      ["memory_search", "obscura__browser_click", "scrapling__get", TOOL_SEARCH].sort(),
    );
  });
});

describe("deferTools", () => {
  const all: ToolSet = { memory_search: echo("memory"), mcp__fetch: echo("fetch a page"), mcp__click: echo("click") };

  it("adds tool_search only when something stays deferred", () => {
    const none = deferTools(all, () => false, new Set());
    expect(Object.keys(none.tools)).toEqual(Object.keys(all));
    expect(none.deferred).toEqual([]);

    const loaded = deferTools(all, (n) => n.startsWith("mcp__"), new Set(["mcp__fetch", "mcp__click"]));
    expect(loaded.deferred).toEqual([]);
    expect(loaded.tools[TOOL_SEARCH]).toBeUndefined();
  });

  it("hides deferred tools until tool_search finds them, then they can be called", async () => {
    const { tools, deferred } = deferTools(all, (n) => n.startsWith("mcp__"), new Set());
    expect(deferred).toEqual(["mcp__fetch", "mcp__click"]);

    const offered: string[][] = [];
    const replies = [
      { type: "tool-call", toolCallId: "1", toolName: TOOL_SEARCH, input: JSON.stringify({ query: "mcp__fetch" }) },
      { type: "tool-call", toolCallId: "2", toolName: "mcp__fetch", input: "{}" },
      { type: "text", text: "ok" },
    ] as const;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        offered.push((options.tools ?? []).map((t) => t.name));
        const reply = replies[offered.length - 1]!;
        return {
          content: [reply],
          finishReason: { unified: reply.type === "text" ? "stop" : "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const result = await generateText({ model, tools, prompt: "go", stopWhen: isStepCount(5) });
    expect(offered[0]).toEqual(["memory_search", TOOL_SEARCH]);
    expect(offered[1]).toEqual(["memory_search", "mcp__fetch", TOOL_SEARCH]);
    expect(result.steps[1]!.toolResults[0]!.output).toBe("fetch a page");
    expect(result.text).toBe("ok");
  });
});

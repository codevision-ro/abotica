import {
  convertToModelMessages,
  isStepCount,
  isToolUIPart,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  closeOpenToolCalls,
  interruptRunMessage,
  loadConversation,
  responseMessageStream,
  saveMessage,
} from "./run-messages";

type Row = {
  id: string;
  conversationId: string;
  role: UIMessage["role"];
  parts: unknown[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};
type Condition = (row: Row) => boolean;

// An in-memory messages table: the conditions below evaluate what the queries ask for.
const { rows } = vi.hoisted(() => ({ rows: new Map<string, Row>() }));

vi.mock("@abotica/db/orm", () => ({
  eq: (column: keyof Row, value: unknown) => (row: Row) => row[column] === value,
  and:
    (...conditions: Condition[]) =>
    (row: Row) =>
      conditions.every((c) => c(row)),
  asc: () => undefined,
  // Only `<json column>->>'<key>' = <value>` is used.
  sql: (strings: TemplateStringsArray, column: keyof Row, value: unknown) => {
    const key = /->>'(\w+)'/.exec(strings[1]!)![1]!;
    return (row: Row) => (row[column] as Record<string, unknown> | null)?.[key] === value;
  },
}));

vi.mock("@abotica/db", () => {
  const select = (where: Condition = () => true, limit = Infinity) => ({
    where: (condition: Condition) => select(condition, limit),
    orderBy: () => select(where, limit),
    limit: (n: number) => select(where, n),
    then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve([...rows.values()].filter(where).slice(0, limit)).then(resolve, reject),
  });
  return {
    messages: { id: "id", conversationId: "conversationId", role: "role", metadata: "metadata", createdAt: "createdAt" },
    db: {
      select: () => ({ from: () => select() }),
      insert: () => ({
        values: (row: Row) => ({
          onConflictDoUpdate: async ({ set }: { set: Partial<Row> }) => {
            const existing = rows.get(row.id);
            rows.set(row.id, existing ? { ...existing, ...set } : row);
          },
        }),
      }),
      update: () => ({
        set: (patch: Partial<Row>) => ({
          where: async (where: Condition) => {
            for (const row of rows.values()) if (where(row)) rows.set(row.id, { ...row, ...patch });
          },
        }),
      }),
    },
  };
});

const CONVERSATION = "c1";
const RUN = "r1";
const STARTED = new Date("2026-10-07T12:00:00Z");

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const toolStep = (n: number) =>
  convertArrayToReadableStream([
    { type: "stream-start" as const, warnings: [] },
    { type: "tool-call" as const, toolCallId: `call-${n}`, toolName: "step", input: JSON.stringify({ n }) },
    { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
  ]);
const textStep = (text: string) =>
  convertArrayToReadableStream([
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t" },
    { type: "text-delta" as const, id: "t", delta: text },
    { type: "text-end" as const, id: "t" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
  ]);

const userMessage: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] };
const assistantRows = () => [...rows.values()].filter((r) => r.role === "assistant");
const toolParts = (parts: unknown[]) => (parts as UIMessage["parts"]).filter(isToolUIPart);

/** Runs a mocked model through the response stream: three tool steps, then a text answer. */
async function runThreeToolSteps(opts: {
  originalMessages?: UIMessage[];
  save?: (message: UIMessage) => Promise<void>;
  onTool?: (n: number) => void;
}) {
  const tools: ToolSet = {
    step: tool({
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        opts.onTool?.(n);
        return `done ${n}`;
      },
    }),
  };
  const model = new MockLanguageModelV4({
    doStream: [{ stream: toolStep(1) }, { stream: toolStep(2) }, { stream: toolStep(3) }, { stream: textStep("All done") }],
  });
  const originalMessages = opts.originalMessages ?? [userMessage];
  const result = streamText({
    model,
    tools,
    messages: await convertToModelMessages(originalMessages),
    stopWhen: isStepCount(10),
  });
  const ended: { responseMessage: UIMessage; isAborted: boolean }[] = [];
  const chunks: UIMessageChunk[] = [];
  const stream = responseMessageStream({
    runId: RUN,
    stream: result.stream,
    tools,
    originalMessages,
    onError: (error) => String(error),
    save: opts.save ?? ((message) => saveMessage(CONVERSATION, message, STARTED)),
    onEnd: async (end) => {
      ended.push(end);
      await saveMessage(CONVERSATION, end.responseMessage, STARTED);
    },
  });
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
  return { ended, chunks };
}

beforeEach(() => rows.clear());
afterEach(() => vi.restoreAllMocks());

describe("responseMessageStream", () => {
  it("saves the answer after every step, under one id, before the next step runs", async () => {
    const seenByTool: number[] = [];
    const saved: Row[][] = [];
    const { ended, chunks } = await runThreeToolSteps({
      // What a tool sees in the table is what a worker dying right then would leave behind.
      onTool: () => seenByTool.push(toolParts(assistantRows()[0]?.parts ?? []).length),
      save: async (message) => {
        await saveMessage(CONVERSATION, message, STARTED);
        saved.push(structuredClone(assistantRows()));
      },
    });

    expect(seenByTool).toEqual([0, 1, 2]);
    expect(saved).toHaveLength(4);
    const id = saved[0]![0]!.id;
    saved.forEach((snapshot, step) => {
      expect(snapshot).toHaveLength(1);
      const [row] = snapshot;
      expect(row!.id).toBe(id);
      expect(row!.metadata).toEqual({ runId: RUN });
      const calls = toolParts(row!.parts);
      expect(calls.map((p) => [p.toolCallId, p.state, p.output])).toEqual(
        [1, 2, 3].slice(0, step + 1).map((n) => [`call-${n}`, "output-available", `done ${n}`]),
      );
    });
    expect(saved[2]![0]!.parts.some((p) => (p as { type: string }).type === "text")).toBe(false);
    expect(saved[3]![0]!.parts).toContainEqual(expect.objectContaining({ type: "text", text: "All done" }));

    // The final save updates the same row: no second assistant message.
    expect(ended).toHaveLength(1);
    expect(ended[0]!.isAborted).toBe(false);
    expect(ended[0]!.responseMessage.id).toBe(id);
    expect(ended[0]!.responseMessage.metadata).toEqual({ runId: RUN });
    expect(assistantRows()).toHaveLength(1);
    expect(assistantRows()[0]!.parts).toEqual(ended[0]!.responseMessage.parts);
    // Clients get the same id.
    expect(chunks.find((c) => c.type === "start")).toMatchObject({ messageId: id });
  });

  it("goes on when a step save fails, and the next save carries the missing parts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let saves = 0;
    const { ended } = await runThreeToolSteps({
      save: async (message) => {
        saves += 1;
        if (saves === 1) throw new Error("database down");
        await saveMessage(CONVERSATION, message, STARTED);
      },
      onTool: (n) => {
        if (n === 3) expect(toolParts(assistantRows()[0]!.parts)).toHaveLength(2);
      },
    });

    expect(saves).toBe(4);
    expect(error).toHaveBeenCalledWith(`[runs] saving a step of run ${RUN} failed:`, expect.any(Error));
    expect(ended[0]!.isAborted).toBe(false);
    expect(toolParts(assistantRows()[0]!.parts)).toHaveLength(3);
  });

  it("makes a continued answer this run's before its first step", async () => {
    const previous: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Asked for approval" }],
      metadata: { runId: "r0" },
    };
    const firstSave: Row[] = [];
    const { ended } = await runThreeToolSteps({
      originalMessages: [userMessage, previous],
      save: async (message) => {
        await saveMessage(CONVERSATION, message, STARTED);
        if (!firstSave.length) firstSave.push(structuredClone(assistantRows()[0]!));
      },
    });

    expect(firstSave[0]).toMatchObject({ id: "a1", metadata: { runId: RUN }, parts: previous.parts });
    expect(ended[0]!.responseMessage.id).toBe("a1");
    expect(assistantRows()).toHaveLength(1);
    expect(assistantRows()[0]!.parts[0]).toEqual(previous.parts[0]);
  });
});

const toolPart = (id: string, state: string, extra: Record<string, unknown> = {}) =>
  ({ type: "tool-step", toolCallId: id, state, input: { n: 1 }, ...extra }) as UIMessage["parts"][number];

describe("closeOpenToolCalls", () => {
  it("fails the calls left without a result and keeps the others", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Working" },
        toolPart("done", "output-available", { output: "ok" }),
        toolPart("writing", "input-streaming", { input: undefined }),
        toolPart("running", "input-available"),
        toolPart("approved", "approval-responded", { approval: { id: "ap1", approved: true } }),
        toolPart("denied", "approval-responded", { approval: { id: "ap2", approved: false } }),
        toolPart("asking", "approval-requested", { approval: { id: "ap3" } }),
      ],
    };
    const closed = closeOpenToolCalls(message, "Stopped");
    const states = Object.fromEntries(toolParts(closed.parts).map((p) => [p.toolCallId, [p.state, p.errorText]]));
    expect(states).toEqual({
      done: ["output-available", undefined],
      writing: ["output-error", "Stopped"],
      running: ["output-error", "Stopped"],
      approved: ["output-error", "Stopped"],
      denied: ["approval-responded", undefined],
      asking: ["approval-requested", undefined],
    });
    expect(toolParts(closed.parts).find((p) => p.toolCallId === "writing")!.input).toEqual({});
    expect(closed.parts[0]).toEqual(message.parts[0]);
  });
});

describe("interruptRunMessage", () => {
  const texts = { toolError: "Interrupted: check before repeating it.", note: "The run was interrupted: worker restarted" };
  const insert = (row: Omit<Row, "conversationId" | "createdAt">) =>
    rows.set(row.id, { conversationId: CONVERSATION, createdAt: STARTED, ...row });

  it("closes the run's open tool calls and says why the run stopped", async () => {
    insert({ id: "u1", role: "user", parts: userMessage.parts, metadata: null });
    insert({ id: "other", role: "assistant", parts: [toolPart("x", "input-available")], metadata: { runId: "r0" } });
    insert({
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        toolPart("call-1", "output-available", { output: "done 1" }),
        toolPart("call-2", "input-available"),
      ],
      metadata: { runId: RUN },
    });

    await interruptRunMessage({ id: RUN, conversationId: CONVERSATION }, texts);

    expect(rows.get("a1")!.parts).toEqual([
      { type: "step-start" },
      toolPart("call-1", "output-available", { output: "done 1" }),
      toolPart("call-2", "output-error", { errorText: texts.toolError }),
      { type: "step-start" },
      { type: "text", text: texts.note, state: "done" },
    ]);
    expect(rows.get("other")!.parts).toEqual([toolPart("x", "input-available")]);
  });

  it("does nothing for a run that saved no step or has no conversation", async () => {
    insert({ id: "a1", role: "assistant", parts: [toolPart("x", "input-available")], metadata: { runId: "r0" } });
    await interruptRunMessage({ id: RUN, conversationId: CONVERSATION }, texts);
    await interruptRunMessage({ id: "r0", conversationId: null }, texts);
    expect(rows.get("a1")!.parts).toEqual([toolPart("x", "input-available")]);
  });

  it("gives the next run the finished steps and the interrupted call", async () => {
    insert({ id: "u1", role: "user", parts: userMessage.parts, metadata: null });
    await runThreeToolSteps({});
    const [answer] = assistantRows();
    // As a worker dying in the fourth step leaves it: that step's call never got its result.
    rows.set(answer!.id, { ...answer!, parts: [...answer!.parts.slice(0, -1), toolPart("call-4", "input-available")] });
    await interruptRunMessage({ id: RUN, conversationId: CONVERSATION }, texts);

    const history = await loadConversation(CONVERSATION);
    const model = await convertToModelMessages(
      history.messages.map((h) => h.message),
      { ignoreIncompleteToolCalls: true },
    );
    const results = model
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .map((p) => (p.type === "tool-result" ? [p.toolCallId, p.output] : null));
    expect(results).toEqual([
      ["call-1", { type: "text", value: "done 1" }],
      ["call-2", { type: "text", value: "done 2" }],
      ["call-3", { type: "text", value: "done 3" }],
      ["call-4", { type: "error-text", value: texts.toolError }],
    ]);
    expect(model.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: texts.note }] });
  });
});

describe("loadConversation", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 9, minute));
  const add = (id: string, role: Row["role"], minute: number, metadata: Row["metadata"] = null) =>
    rows.set(id, {
      id,
      conversationId: CONVERSATION,
      role,
      parts: [{ type: "text", text: id }],
      metadata,
      createdAt: at(minute),
    });
  const compaction = (summary: string, coversUntil: number) => ({
    kind: "compaction",
    coversUntil: at(coversUntil).toISOString(),
    summary,
    model: { provider: "anthropic", model: "test" },
    tokens: { before: 900, after: 100 },
    flushedMemoryIds: [],
    toolsUsed: [],
  });

  it("gives every message when the conversation was never compacted", async () => {
    add("u1", "user", 0);
    add("a1", "assistant", 1);
    const history = await loadConversation(CONVERSATION);
    expect(history.compaction).toBeNull();
    expect(history.messages.map((m) => m.message.id)).toEqual(["u1", "a1"]);
  });

  it("gives the newest compaction and only the messages after the last one it covers", async () => {
    add("u1", "user", 0);
    add("a1", "assistant", 1);
    add("c1", "system", 2, compaction("first", 0));
    add("u2", "user", 3);
    add("a2", "assistant", 4);
    // Made while a run was answering u3: it sorts after the answer, which sorts at the run's start.
    add("u3", "user", 5);
    add("a3", "assistant", 6);
    add("c2", "system", 7, compaction("second", 4));
    add("withheld", "system", 8, { kind: "delegation-report", tasks: [], withheld: true });

    const history = await loadConversation(CONVERSATION);
    expect(history.compaction?.metadata.summary).toBe("second");
    expect(history.compaction?.createdAt).toEqual(at(7));
    expect(history.messages.map((m) => m.message.id)).toEqual(["u3", "a3"]);
    // Stored messages stay as they were.
    expect([...rows.keys()]).toEqual(["u1", "a1", "c1", "u2", "a2", "u3", "a3", "c2", "withheld"]);
  });
});

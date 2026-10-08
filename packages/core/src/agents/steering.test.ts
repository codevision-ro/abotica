import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  convertToModelMessages,
  isStepCount,
  readUIMessageStream,
  streamText,
  tool,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StoredMessage } from "../runs/run-messages";
import { prepareSteps } from "./step-preparation";
import { answerSegments, createSteering, type Steer, UNDELIVERED_NOTE, withUndeliveredNotes } from "./steering";

/**
 * Steering end to end with a scripted model: a message that arrives while a tool runs reaches the next
 * step's prompt after the tool's result, the answer reflects it, a run about to wait for approval
 * takes nothing in, and the answer is stored split so the next run replays the order the model saw.
 */

const STARTED = new Date("2026-10-08T10:00:00Z");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const streamOf = (...parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: "stream-start", warnings: [] }, ...parts]),
});
const callTool = (id: string, name = "migrate") =>
  streamOf(
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify({}) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
  );
const answer = (text: string) =>
  streamOf(
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  );

type Prompt = LanguageModelV4CallOptions["prompt"];
const promptTexts = (prompt: Prompt) =>
  prompt.flatMap((m) =>
    m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [`user: ${p.text}`] : [])) : [m.role],
  );

const user = (id: string, text: string, createdAt: Date): StoredMessage => ({
  message: { id, role: "user", parts: [{ type: "text", text }] },
  createdAt,
});
const request = user("u1", "Set up the database with SQLite", new Date(STARTED.getTime() - 1000));
const steerMessage = user("u2", "Stop, use Postgres, not SQLite", new Date(STARTED.getTime() + 5000));

/** A table of the conversation's new user messages; `mark` records what the run took in. */
function inbox() {
  const waiting: StoredMessage[] = [];
  const marked: { ids: string[]; afterStep: number }[] = [];
  return {
    waiting,
    marked,
    load: vi.fn(async () => waiting.filter((m) => !marked.some((x) => x.ids.includes(m.message.id)))),
    mark: vi.fn(async (ids: string[], afterStep: number) => void marked.push({ ids, afterStep })),
  };
}

/** Runs the model with one tool and the steering preparer; returns the prompts, the answer and the steers. */
async function run(opts: {
  reply: (call: number, prompt: Prompt) => ReturnType<typeof answer>;
  box: ReturnType<typeof inbox>;
  onTool?: () => void;
  approval?: boolean;
}) {
  const events: string[] = [];
  const prompts: Prompt[] = [];
  const tools: ToolSet = {
    migrate: tool({
      inputSchema: z.object({}),
      execute: async () => {
        opts.onTool?.();
        events.push("tool done");
        return "migrated";
      },
    }),
  };
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return opts.reply(prompts.length, prompt);
    },
  });
  const steering = createSteering({
    load: async () => {
      events.push("load");
      return opts.box.load();
    },
    mark: opts.box.mark,
    toModel: async (messages) => convertToModelMessages(messages.map((m) => m.message)),
    inPrompt: [request.message.id],
  });
  const original: UIMessage[] = [request.message];
  const result = streamText({
    model,
    tools,
    messages: await convertToModelMessages(original),
    stopWhen: isStepCount(10),
    prepareStep: prepareSteps([steering.preparer]),
    ...(opts.approval ? { toolApproval: { migrate: "user-approval" as const } } : {}),
  });
  let message: UIMessage | undefined;
  for await (const snapshot of readUIMessageStream({ stream: toUIMessageStream({ stream: result.stream, tools }) })) {
    message = snapshot;
  }
  return { prompts, events, message: message!, steers: steering.steers, text: (await result.finalStep).text };
}

describe("steering a running run", () => {
  it("puts a message that arrived while a tool ran into the next step, after the tool's result", async () => {
    const box = inbox();
    const { prompts, events, text, steers } = await run({
      box,
      // The user writes while the first tool call runs.
      onTool: () => box.waiting.push(steerMessage),
      reply: (call, prompt) =>
        call === 1
          ? callTool("call_1")
          : answer(promptTexts(prompt).some((t) => t.includes("Postgres")) ? "Switched to Postgres." : "Done with SQLite."),
    });

    expect(prompts).toHaveLength(2);
    // The second call sees the request, the tool call with its result, then the new message, at the end.
    expect(promptTexts(prompts[1]!)).toEqual([
      "user: Set up the database with SQLite",
      "assistant",
      "tool",
      "user: Stop, use Postgres, not SQLite",
    ]);
    // Taken in only after the step's tool call had its result: nothing was interrupted or skipped.
    expect(events).toEqual(["tool done", "load"]);
    expect(text).toBe("Switched to Postgres.");
    expect(box.marked).toEqual([{ ids: ["u2"], afterStep: 0 }]);
    expect(steers).toEqual([{ step: 1, messages: [steerMessage] }]);
  });

  it("takes each message in once, and keeps it in the later steps' prompts", async () => {
    const box = inbox();
    const { prompts } = await run({
      box,
      onTool: () => {
        if (!box.waiting.length) box.waiting.push(steerMessage);
      },
      reply: (call) => (call <= 2 ? callTool(`call_${call}`) : answer("Done")),
    });

    const steered = prompts.map((p) => promptTexts(p).filter((t) => t.includes("Postgres")).length);
    expect(steered).toEqual([0, 1, 1]);
    expect(box.mark).toHaveBeenCalledOnce();
  });

  it("never takes in a message that is already in the run's prompt", async () => {
    const box = inbox();
    box.waiting.push(request);
    const { prompts } = await run({ box, reply: (call) => (call === 1 ? callTool("call_1") : answer("Done")) });

    expect(promptTexts(prompts[1]!).filter((t) => t.startsWith("user:"))).toHaveLength(1);
    expect(box.mark).not.toHaveBeenCalled();
  });

  it("does not take in messages when the run is going to wait for an approval", async () => {
    const box = inbox();
    box.waiting.push(steerMessage);
    const { prompts, message } = await run({ box, approval: true, reply: () => callTool("call_1") });

    expect(prompts).toHaveLength(1);
    expect(box.load).not.toHaveBeenCalled();
    expect(box.mark).not.toHaveBeenCalled();
    expect(message.parts.some((p) => "state" in p && p.state === "approval-requested")).toBe(true);
  });

  it("leaves the messages for the follow-up when marking them fails", async () => {
    const box = inbox();
    box.mark.mockRejectedValueOnce(new Error("database down"));
    const onError = vi.fn();
    const steering = createSteering({
      load: async () => [steerMessage],
      mark: box.mark,
      toModel: async () => [{ role: "user", content: "x" }],
      inPrompt: [],
      onError,
    });
    expect(await steering.preparer({ stepNumber: 1, steps: [], messages: [] })).toBeNull();
    expect(steering.steers).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("answerSegments", () => {
  it("stores the answer split around the steered message, in the order the model saw it", async () => {
    const box = inbox();
    const { message, steers } = await run({
      box,
      onTool: () => box.waiting.push(steerMessage),
      reply: (call) => (call === 1 ? callTool("call_1") : answer("Switched to Postgres.")),
    });

    const segments = answerSegments({ ...message, id: "a1" }, STARTED, steers);
    expect(segments.map((s) => s.message.id)).toEqual(["a1", "a1-2"]);
    expect(segments[0]!.createdAt).toEqual(STARTED);
    expect(segments[1]!.createdAt.getTime()).toBe(steerMessage.createdAt.getTime() + 1);
    expect(segments[0]!.message.parts.map((p) => p.type)).toEqual(["step-start", "tool-migrate"]);
    expect(segments[1]!.message.parts.map((p) => p.type)).toEqual(["step-start", "text"]);

    // The conversation as the next run loads it: sorted by time.
    const stored = [request, ...segments, steerMessage].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(stored.map((s) => s.message.id)).toEqual(["u1", "a1", "u2", "a1-2"]);
    const replay = await convertToModelMessages(stored.map((s) => s.message));
    expect(replay.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  });

  it("keeps the answer whole without steers, or while the step after a steer has not started", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "Working" }],
    };
    expect(answerSegments(message, STARTED, [])).toEqual([{ message, createdAt: STARTED }]);
    const pending: Steer = { step: 1, messages: [steerMessage] };
    expect(answerSegments(message, STARTED, [pending])).toEqual([{ message, createdAt: STARTED }]);
  });

  it("counts the steps of a continued answer before this run's, and splits at every steer", () => {
    const step = (text: string): UIMessage["parts"] => [{ type: "step-start" }, { type: "text", text }];
    const later = user("u3", "Also add an index", new Date(STARTED.getTime() + 9000));
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      // One step from the run that asked for approval, then this run's steps 0, 1 and 2.
      parts: [...step("before approval"), ...step("s0"), ...step("s1"), ...step("s2")],
    };
    const steers: Steer[] = [
      { step: 2, messages: [later] },
      { step: 1, messages: [steerMessage] },
    ];
    const segments = answerSegments(message, STARTED, steers, 1);
    expect(
      segments.map((s) => [s.message.id, s.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))]),
    ).toEqual([
      ["a1", ["before approval", "s0"]],
      ["a1-2", ["s1"]],
      ["a1-3", ["s2"]],
    ]);
    expect(segments.map((s) => s.createdAt.getTime())).toEqual([
      STARTED.getTime(),
      steerMessage.createdAt.getTime() + 1,
      later.createdAt.getTime() + 1,
    ]);
  });
});

describe("withUndeliveredNotes", () => {
  it("tells the model on the first message after an answer the user never got", () => {
    const held: StoredMessage = {
      message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Stale" }], metadata: { undelivered: true } },
      createdAt: STARTED,
    };
    const second = user("u3", "And add an index", new Date(STARTED.getTime() + 6000));
    const noted = withUndeliveredNotes([request, held, steerMessage, second]);

    expect(noted[2]!.message.parts).toEqual([{ type: "text", text: UNDELIVERED_NOTE }, ...steerMessage.message.parts]);
    expect(noted[3]).toBe(second);
    expect(noted[0]).toBe(request);
  });

  it("leaves a conversation whose answers were all sent as it is", () => {
    const sent: StoredMessage = {
      message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done" }] },
      createdAt: STARTED,
    };
    const history = [request, sent, steerMessage];
    expect(withUndeliveredNotes(history)).toEqual(history);
  });
});

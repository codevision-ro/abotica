import type { ModelMessage, StepResult, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { detectLoop, LOOP_THRESHOLDS, loopGuard, loopNudgeText } from "./stuck";

const { repeat: REPEAT, error: ERROR, alternation: ALTERNATION } = LOOP_THRESHOLDS;

type Call = { tool: string; input: unknown; output?: unknown; thrown?: string; id?: string };
/** Only the content matters to the detector; the rest of a step is left out. */
type Step = StepResult<ToolSet>;

let ids = 0;

/** A step that made these calls, each ending in its output or, with `thrown`, in a tool error. */
function step(...calls: Call[]): Step {
  const content = calls.flatMap(({ tool, input, output, thrown, id = `call_${++ids}` }) => [
    { type: "tool-call", toolCallId: id, toolName: tool, input },
    thrown === undefined
      ? { type: "tool-result", toolCallId: id, toolName: tool, input, output }
      : { type: "tool-error", toolCallId: id, toolName: tool, input, error: new Error(thrown) },
  ]);
  return { content } as unknown as Step;
}

const textStep = () => ({ content: [{ type: "text", text: "Thinking it over" }] }) as unknown as Step;
const times = (n: number, make: () => Step) => Array.from({ length: n }, make);

const read = (path: string, output: unknown = "same text"): Call => ({ tool: "file_read", input: { path }, output });

describe("detectLoop", () => {
  it(`finds the same call with the same result ${REPEAT} times in a row`, () => {
    expect(detectLoop(times(REPEAT - 1, () => step(read("a.txt"))))).toBeNull();
    expect(detectLoop(times(REPEAT, () => step(read("a.txt"))))).toEqual({
      pattern: "repeat",
      tools: ["file_read"],
      steps: REPEAT,
    });
  });

  it("compares inputs by value, whatever the order of their keys", () => {
    const steps = Array.from({ length: REPEAT }, (_, i) =>
      step({
        tool: "web_fetch",
        input: i % 2 ? { url: "https://a.test", max: 10 } : { max: 10, url: "https://a.test" },
        output: "page",
      }),
    );
    expect(detectLoop(steps)?.pattern).toBe("repeat");
  });

  it("ignores the call id a cut output names in its notice", () => {
    const cut = (id: string) => ({
      ...read("big.log"),
      id,
      output: `start [... 900 characters cut. Full output in your workspace: tool-output/run/${id}.txt ...] end`,
    });
    expect(detectLoop(Array.from({ length: REPEAT }, (_, i) => step(cut(`c${i}`))))?.pattern).toBe("repeat");
  });

  it("does not flag varied calls", () => {
    expect(detectLoop(Array.from({ length: ALTERNATION + 1 }, (_, i) => step(read(`${i}.txt`))))).toBeNull();
  });

  it("does not flag the same call when its result changes (polling that makes progress)", () => {
    const steps = ["queued", "running", "running 50%", "done"].map((status) =>
      step({ tool: "run_get", input: { runId: "r1" }, output: { status } }),
    );
    expect(detectLoop(steps)).toBeNull();
  });

  it("does not flag a shell command that sleeps, then checks a status that has not changed yet", () => {
    const poll = () =>
      step({ tool: "shell_run", input: { command: "sleep 60; pgrep -f build && echo running" }, output: "running" });
    expect(detectLoop(times(REPEAT * 2, poll))).toBeNull();
    // Sleeping in one call and checking in the next is polling too.
    const sleep = () => step({ tool: "shell_run", input: { command: "sleep 30" }, output: "" });
    const check = () => step({ tool: "shell_run", input: { command: "tail -1 build.log" }, output: "compiling" });
    expect(detectLoop(Array.from({ length: ALTERNATION }, (_, i) => (i % 2 ? check() : sleep())))).toBeNull();
  });

  it(`finds the same call failing ${ERROR} times in a row, whatever the errors say`, () => {
    const failing = () => step({ tool: "shell_run", input: { command: "make" }, thrown: `error ${ids}` });
    expect(detectLoop(times(ERROR - 1, failing))).toBeNull();
    expect(detectLoop(times(ERROR, failing))).toEqual({ pattern: "error", tools: ["shell_run"], steps: ERROR });
  });

  it("counts an error returned as data, the way most tools report one", () => {
    const steps = times(ERROR, () => step({ tool: "delegate_task", input: { taskId: "t1" }, output: { error: "Busy" } }));
    expect(detectLoop(steps)?.pattern).toBe("error");
  });

  it("still finds a sleeping command that fails the same way each time", () => {
    const failing = () => step({ tool: "shell_run", input: { command: "sleep 5; make" }, thrown: "exit 2" });
    expect(detectLoop(times(ERROR, failing))?.pattern).toBe("error");
  });

  it("does not flag failures of different calls", () => {
    const steps = Array.from({ length: ERROR }, (_, i) =>
      step({ tool: "shell_run", input: { command: `c${i}` }, thrown: "exit 1" }),
    );
    expect(detectLoop(steps)).toBeNull();
  });

  it(`finds an A-B-A-B alternation over ${ALTERNATION} steps`, () => {
    const a = () => step(read("a.txt"));
    const b = () => step({ tool: "file_write", input: { path: "a.txt", content: "x" }, output: { ok: true } });
    const alternate = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? b() : a()));
    expect(detectLoop(alternate(ALTERNATION - 1))).toBeNull();
    expect(detectLoop(alternate(ALTERNATION))).toEqual({
      pattern: "alternation",
      tools: ["file_read", "file_write"],
      steps: ALTERNATION,
    });
  });

  it("does not flag an alternation whose results change", () => {
    const a = (n: number) => step(read("count.txt", String(n)));
    const b = () => step({ tool: "shell_run", input: { command: "increment" }, output: "ok" });
    expect(detectLoop(Array.from({ length: ALTERNATION }, (_, i) => (i % 2 ? b() : a(i))))).toBeNull();
  });

  it("only looks at the steps since the last one without tool calls", () => {
    const steps = [...times(REPEAT - 1, () => step(read("a.txt"))), textStep(), step(read("a.txt"))];
    expect(detectLoop(steps)).toBeNull();
  });

  it("treats parallel calls returned in another order as the same step", () => {
    const pair = (flip: boolean) => {
      const calls = [read("a.txt", "A"), read("b.txt", "B")];
      return step(...(flip ? calls.reverse() : calls));
    };
    expect(detectLoop(Array.from({ length: REPEAT }, (_, i) => pair(i % 2 === 1)))).toEqual({
      pattern: "repeat",
      tools: ["file_read"],
      steps: REPEAT,
    });
  });

  it("uses twice OpenHands' thresholds", () => {
    expect(LOOP_THRESHOLDS).toEqual({ repeat: 8, error: 6, alternation: 12 });
  });
});

describe("loopGuard", () => {
  const prompt: ModelMessage[] = [{ role: "user", content: "Do the task" }];
  const looping = times(REPEAT, () => step(read("a.txt")));

  it("nudges once on the first loop, appending a user message", async () => {
    const onNudge = vi.fn();
    const guard = loopGuard(onNudge);

    const change = await guard.nudge({ stepNumber: REPEAT, steps: looping, messages: prompt });
    const text = loopNudgeText({ pattern: "repeat", tools: ["file_read"], steps: REPEAT });
    expect(change).toEqual({ messages: [...prompt, { role: "user", content: text }] });
    expect(text).toContain(`You called \`file_read\` with the same arguments ${REPEAT} times in a row`);
    expect(onNudge).toHaveBeenCalledExactlyOnceWith({ pattern: "repeat", tools: ["file_read"], steps: REPEAT }, text);

    // The nudge stays in the prompt (streamText carries it forward): it is not added again.
    const more = [...looping, step(read("a.txt"))];
    expect(await guard.nudge({ stepNumber: REPEAT + 1, steps: more, messages: change!.messages })).toBeNull();
    expect(onNudge).toHaveBeenCalledOnce();
  });

  it("stops the run only on a loop after the nudge", async () => {
    const guard = loopGuard(() => {});
    expect(guard.stopping(looping)).toBeNull();
    await guard.nudge({ stepNumber: REPEAT, steps: looping, messages: prompt });
    // The model changed approach: nothing stops it.
    expect(guard.stopping([...looping, step(read("b.txt"))])).toBeNull();
    expect(guard.stopping([...looping, step(read("a.txt"))])?.pattern).toBe("repeat");
  });

  it("leaves a run without loops alone", async () => {
    const onNudge = vi.fn();
    const guard = loopGuard(onNudge);
    const steps = ["a", "b", "c", "d", "e", "f"].map((p) => step(read(`${p}.txt`)));
    expect(await guard.nudge({ stepNumber: 6, steps, messages: prompt })).toBeNull();
    expect(guard.stopping(steps)).toBeNull();
    expect(onNudge).not.toHaveBeenCalled();
  });
});

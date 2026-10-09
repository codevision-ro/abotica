import { createHash } from "node:crypto";
import type { StepResult, ToolSet } from "ai";
import { type StepPreparer, withUserMessage } from "./step-preparation";

/**
 * Loop detection: a run that keeps making the same tool calls and getting the same results burns steps
 * and money until a limit stops it. The signals are OpenHands' stuck detector
 * (sdk/conversation/stuck_detector.py). Pure: it reads only the run's steps, the steps streamText hands
 * to stop conditions and to prepareStep.
 */

/**
 * Steps in a row that make a loop: the same calls with the same results, the same calls failing, A-B-A-B.
 * Twice OpenHands' values (4, 3, 6): agents here do long work, where a check repeated a few times is
 * normal, and a stop ends the run with its answer so far instead of failing it.
 */
export const LOOP_THRESHOLDS = { repeat: 8, error: 6, alternation: 12 } as const;

type LoopPattern = keyof typeof LOOP_THRESHOLDS;

/** A loop at the end of a run's steps: its pattern, the tools it calls and how many steps it spans. */
type LoopHit = { pattern: LoopPattern; tools: string[]; steps: number };

type Step = Pick<StepResult<ToolSet>, "content">;

/**
 * A step's tool calls, fingerprinted: `calls` the calls alone, `outcome` the calls with their results.
 * `waits`: every call waited before it looked (a shell command with a sleep), so the step is a poll.
 */
type StepPrint = { calls: string; outcome: string; tools: string[]; failed: boolean; waits: boolean };

const SHELL_TOOLS = new Set(["shell_run", "shell_run_root"]);
/** `sleep 30`, `sleep 1m`, `sleep 0.5`: a command that waits on purpose before it checks. */
const SLEEP_RE = /\bsleep\s+\d/;

/** A shell command that sleeps: polling a build, a crawl or a server, which reads the same until it changes. */
function waitsBeforeChecking(tool: string, input: unknown): boolean {
  if (!SHELL_TOOLS.has(tool) || typeof input !== "object" || input === null) return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && SLEEP_RE.test(command);
}

/** JSON with object keys sorted, so equal values give the same text whatever the order of their keys. */
function stableJson(value: unknown): string {
  const sorted = (_key: string, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v;
  return JSON.stringify(value, sorted) ?? "undefined";
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64url");

/** Tools report most failures as data ({ error }); a thrown error, an MCP server's isError included, is a tool-error part. */
function isErrorOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  return "error" in output;
}

/** The fingerprint of a step's tool calls and results; null for a step that called no tool. */
function stepPrint(step: Step): StepPrint | null {
  const outcomes = step.content.flatMap((part) => {
    if (part.type !== "tool-result" && part.type !== "tool-error") return [];
    if (part.type === "tool-result" && part.preliminary) return [];
    const call = `${part.toolName}:${stableJson(part.input)}`;
    const waits = waitsBeforeChecking(part.toolName, part.input);
    if (part.type === "tool-error") return [{ tool: part.toolName, call, result: "error", failed: true, waits }];
    // A cut output names the file with its full text after the call id (tool-output.ts): without the
    // id, the same output twice reads the same.
    const result = stableJson(part.output).replaceAll(part.toolCallId, "");
    return [{ tool: part.toolName, call, result, failed: isErrorOutput(part.output), waits }];
  });
  if (!outcomes.length) return null;
  // Parallel calls come back in any order.
  outcomes.sort((a, b) => (a.call === b.call ? (a.result < b.result ? -1 : 1) : a.call < b.call ? -1 : 1));
  return {
    calls: digest(outcomes.map((o) => o.call).join("\n")),
    outcome: digest(outcomes.map((o) => `${o.call}\n${o.result}`).join("\n")),
    tools: [...new Set(outcomes.map((o) => o.tool))],
    failed: outcomes.every((o) => o.failed),
    waits: outcomes.every((o) => o.waits),
  };
}

/** The fingerprints of the last steps that called tools, oldest first, at most `max` of them. */
function trailingPrints(steps: Step[], max: number): StepPrint[] {
  const prints: StepPrint[] = [];
  for (let i = steps.length - 1; i >= 0 && prints.length < max; i--) {
    const print = stepPrint(steps[i]!);
    if (!print) break;
    prints.unshift(print);
  }
  return prints;
}

const hit = (pattern: LoopPattern, prints: StepPrint[]): LoopHit => ({
  pattern,
  tools: [...new Set(prints.flatMap((p) => p.tools))],
  steps: prints.length,
});

/** The loop the run's last steps are in, or null. A loop always ends with the last step. */
export function detectLoop(steps: Step[]): LoopHit | null {
  const recent = trailingPrints(steps, Math.max(...Object.values(LOOP_THRESHOLDS)));
  const last = (n: number) => (recent.length >= n ? recent.slice(-n) : null);

  const failing = last(LOOP_THRESHOLDS.error);
  if (failing?.every((p) => p.failed && p.calls === failing[0]!.calls)) return hit("error", failing);
  // Polling is not a loop: a status that has not changed yet reads the same each time it is checked.
  // The run's step and time limits still bound it.
  const repeated = last(LOOP_THRESHOLDS.repeat);
  if (repeated?.every((p) => p.outcome === repeated[0]!.outcome) && !repeated[0]!.waits) return hit("repeat", repeated);
  const alternating = last(LOOP_THRESHOLDS.alternation);
  if (
    alternating &&
    // Sleeping, then checking: polling too.
    !alternating.some((p) => p.waits) &&
    alternating[0]!.outcome !== alternating[1]!.outcome &&
    alternating.every((p, i) => i < 2 || p.outcome === alternating[i - 2]!.outcome)
  ) {
    return hit("alternation", alternating);
  }
  return null;
}

/** What the model is told the first time it loops. */
export function loopNudgeText(loop: LoopHit): string {
  const tools = loop.tools.map((t) => `\`${t}\``).join(", ");
  const way = "Change your approach, or stop and explain what blocks you.";
  switch (loop.pattern) {
    case "repeat":
      return `(Automatic notice) You called ${tools} with the same arguments ${loop.steps} times in a row and got the same result each time. ${way}`;
    case "error":
      return `(Automatic notice) You called ${tools} with the same arguments ${loop.steps} times in a row and it failed each time. The same call will fail again: read the error and correct the arguments. ${way}`;
    case "alternation":
      return `(Automatic notice) You keep alternating between the same calls to ${tools} with the same results (${loop.steps} steps in a row). ${way}`;
  }
}

type LoopGuard = {
  /** Before a step: tells the model about the first loop of the run, once. */
  nudge: StepPreparer;
  /** After a step: the loop the run is in after the nudge, which ends it; null to go on. */
  stopping: (steps: Step[]) => LoopHit | null;
};

/**
 * Loop handling for one run: the first loop gets a nudge (a user message appended to the prompt, which
 * stays for the later steps), a loop after it stops the run, which ends with its answer so far (not as
 * a failure: see runner.ts). `onNudge` reports the nudge, e.g. as a run event.
 */
export function loopGuard(onNudge: (loop: LoopHit, text: string) => void): LoopGuard {
  let nudged = false;
  return {
    nudge: ({ steps, messages }) => {
      if (nudged) return null;
      const loop = detectLoop(steps);
      if (!loop) return null;
      nudged = true;
      const text = loopNudgeText(loop);
      onNudge(loop, text);
      return { messages: withUserMessage(messages, text) };
    },
    stopping: (steps) => (nudged ? detectLoop(steps) : null),
  };
}

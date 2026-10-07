import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { CompactionRecord } from "../runs/compaction-record";
import type { StoredMessage } from "../runs/run-messages";
import {
  approxTokens,
  cutRunPrompt,
  effectiveWindow,
  estimateTokens,
  historyCut,
  keepBudget,
  measuredPrompt,
  pickCut,
  shouldCompact,
  SUMMARY_PREFIX,
  summaryMessage,
  summaryRequest,
  transcript,
} from "./compaction";

const at = (minute: number, ms = 0) => new Date(Date.UTC(2026, 9, 8, 9, minute, 0, ms));
const text = (id: string, role: UIMessage["role"], value: string, createdAt: Date): StoredMessage => ({
  message: { id, role, parts: [{ type: "text", text: value }] },
  createdAt,
});

describe("effectiveWindow", () => {
  const catalog = [
    { provider: "anthropic" as const, id: "big", contextWindow: 200_000 },
    { provider: "deepseek" as const, id: "small", contextWindow: 64_000 },
    { provider: "ollama" as const, id: "local", contextWindow: null },
  ];

  it("is the smallest window of the chain, since any step can fall back to any model", () => {
    const chain = [
      { provider: "anthropic", model: "big" },
      { provider: "deepseek", model: "small" },
    ];
    expect(effectiveWindow(chain, catalog)).toBe(64_000);
  });

  it("leaves out models without a known window, and is null when none is known", () => {
    expect(
      effectiveWindow(
        [
          { provider: "anthropic", model: "big" },
          { provider: "ollama", model: "local" },
        ],
        catalog,
      ),
    ).toBe(200_000);
    expect(effectiveWindow([{ provider: "ollama", model: "local" }], catalog)).toBeNull();
    expect(effectiveWindow([{ provider: "openai", model: "unlisted" }], catalog)).toBeNull();
  });
});

describe("estimateTokens", () => {
  const messages = [text("u1", "user", "a".repeat(400), at(0)), text("a1", "assistant", "b".repeat(400), at(0, 1))];
  const later = text("u2", "user", "c".repeat(400), at(5));

  it("adds the messages after the measured prompt to its size", () => {
    expect(estimateTokens([...messages, later], { tokens: 1_000, since: at(1) }, 50)).toBe(
      1_000 + approxTokens(later.message.parts),
    );
  });

  it("counts the fixed part and every message without a measurement", () => {
    const all = [...messages, later];
    expect(estimateTokens(all, null, 50)).toBe(50 + all.reduce((sum, m) => sum + approxTokens(m.message.parts), 0));
  });
});

describe("measuredPrompt", () => {
  const compaction = { metadata: { tokens: { before: 9_000, after: 1_200 } }, createdAt: at(10) } as CompactionRecord;

  it("is the last step's prompt and answer, counting messages sent after its run started", () => {
    expect(measuredPrompt(null, { tokens: 5_000, runStartedAt: at(1), at: at(3) })).toEqual({
      tokens: 5_000,
      since: at(1),
    });
  });

  it("is the compaction's estimate when it came after the last step", () => {
    expect(measuredPrompt(compaction, { tokens: 9_000, runStartedAt: at(1), at: at(3) })).toEqual({
      tokens: 1_200,
      since: at(10),
    });
    expect(measuredPrompt(compaction, { tokens: 2_000, runStartedAt: at(11), at: at(12) })).toEqual({
      tokens: 2_000,
      since: at(11),
    });
    expect(measuredPrompt(compaction, null)).toEqual({ tokens: 1_200, since: at(10) });
    expect(measuredPrompt(null, null)).toBeNull();
  });
});

describe("shouldCompact", () => {
  const minutes = (n: number) => n * 60_000;

  it("compacts from 90% of the window, idle or not", () => {
    expect(shouldCompact({ estimate: 900, window: 1_000, idleMs: 0, cacheTtl: "1h" })).toBe("hard");
    expect(shouldCompact({ estimate: 899, window: 1_000, idleMs: 0, cacheTtl: "1h" })).toBeNull();
  });

  it("compacts from 60% only when the conversation was idle longer than its cache lives", () => {
    expect(shouldCompact({ estimate: 600, window: 1_000, idleMs: minutes(4), cacheTtl: "5m" })).toBeNull();
    expect(shouldCompact({ estimate: 600, window: 1_000, idleMs: minutes(6), cacheTtl: "5m" })).toBe("soft");
    expect(shouldCompact({ estimate: 600, window: 1_000, idleMs: minutes(30), cacheTtl: "1h" })).toBeNull();
    expect(shouldCompact({ estimate: 600, window: 1_000, idleMs: minutes(61), cacheTtl: "1h" })).toBe("soft");
    expect(shouldCompact({ estimate: 599, window: 1_000, idleMs: minutes(61), cacheTtl: "1h" })).toBeNull();
  });

  it("never compacts without a known window", () => {
    expect(shouldCompact({ estimate: 1_000_000, window: null, idleMs: minutes(120), cacheTtl: "5m" })).toBeNull();
  });
});

describe("keepBudget", () => {
  it("keeps 20k tokens, or 20% of a smaller window, and nothing after an overflow", () => {
    expect(keepBudget("hard", 200_000, 180_000)).toBe(20_000);
    expect(keepBudget("soft", 32_000, 20_000)).toBe(6_400);
    expect(keepBudget("hard", null, 50_000)).toBe(10_000);
    expect(keepBudget("overflow", 200_000, 200_000)).toBe(0);
  });
});

describe("pickCut", () => {
  const call = (id: string, size = 10): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "file_read", input: { path: "x".repeat(size) } }],
  });
  const result = (id: string, size = 10): ModelMessage => ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName: "file_read", output: { type: "text", value: "y".repeat(size) } },
    ],
  });
  const steps: ModelMessage[] = [
    call("1", 400),
    result("1", 4_000),
    call("2"),
    result("2", 800),
    { role: "assistant", content: [call("3").content[0] as never, call("4").content[0] as never] },
    { role: "tool", content: [...(result("3", 2_000).content as never[]), ...(result("4", 50).content as never[])] },
    { role: "user", content: "(Automatic notice) change approach" },
    call("5", 300),
    result("5", 600),
  ];
  const entries = steps.map((m) => ({ tokens: approxTokens(m.content), cuttable: m.role !== "tool" }));

  it("never parts a tool call from its result, whatever the budget", () => {
    for (let keepTokens = 0; keepTokens <= 2_000; keepTokens += 25) {
      for (let keepFrom = 0; keepFrom <= steps.length; keepFrom++) {
        const cut = pickCut(entries, keepFrom, keepTokens);
        expect(steps[cut]?.role).not.toBe("tool");
        expect(cut).toBeLessThanOrEqual(keepFrom);
      }
    }
  });

  it("keeps the current turn even over the budget, and the recent messages that fit before it", () => {
    expect(pickCut(entries, 7, 0)).toBe(7);
    // The notice fits, the parallel calls with their long result do not.
    expect(pickCut(entries, 7, approxTokens(steps[6]!.content) + 5)).toBe(6);
    expect(pickCut(entries, 7, 700)).toBe(4);
  });

  it("is 0 when everything before the current turn fits: nothing to summarize", () => {
    expect(pickCut(entries, 7, 100_000)).toBe(0);
  });
});

describe("historyCut", () => {
  it("keeps the current turn from the last user message, and cuts only between distinct times", () => {
    const history = [
      text("u1", "user", "a".repeat(2_000), at(0)),
      text("a1", "assistant", "b".repeat(2_000), at(1)),
      text("r1", "user", "report", at(2)),
      // Saved in the same millisecond: coversUntil could not tell them apart.
      text("r2", "user", "report", at(2)),
      text("a2", "assistant", "c".repeat(2_000), at(3)),
      text("u2", "user", "Go on", at(4)),
    ];
    expect(historyCut(history, 0)).toBe(5);
    expect(historyCut(history, approxTokens(history[4]!.message.parts))).toBe(4);
    // r2 fits and r1 does not, but the cut cannot fall between them.
    expect(historyCut(history, approxTokens(history[4]!.message.parts) + 10)).toBe(4);
    expect(historyCut(history, approxTokens(history[4]!.message.parts) + 20)).toBe(2);
  });

  it("keeps a continuation's last message when no user message is left", () => {
    expect(historyCut([text("a1", "assistant", "x".repeat(800), at(0)), text("a2", "assistant", "y", at(1))], 0)).toBe(1);
  });
});

describe("cutRunPrompt", () => {
  const user = (content: string): ModelMessage => ({ role: "user", content });
  const assistant = (content: string): ModelMessage => ({ role: "assistant", content });
  const tool = (id: string, value: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName: "file_read", output: { type: "text", value } }],
  });
  const call = (id: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "file_read", input: {} }],
  });
  const prompt = [
    user("summary"),
    user("old question"),
    assistant("old answer"),
    user("the request"),
    call("1"),
    tool("1", "z".repeat(4_000)),
    call("2"),
    tool("2", "short"),
  ];

  it("summarizes the history and the older steps, and keeps the request and the last steps", () => {
    const cut = cutRunPrompt(prompt, { skip: 1, requestStart: 3, requestEnd: 4, keepTokens: 100 })!;
    expect(cut.summarize).toEqual(prompt.slice(1, 6));
    expect(cut.keep).toEqual([prompt[3], ...prompt.slice(6)]);
  });

  it("keeps every step that fits, and summarizes only the history then", () => {
    const cut = cutRunPrompt(prompt, { skip: 1, requestStart: 3, requestEnd: 4, keepTokens: 10_000 })!;
    expect(cut.summarize).toEqual(prompt.slice(1, 3));
    expect(cut.keep).toEqual(prompt.slice(3));
  });

  it("is null when there is nothing to summarize", () => {
    expect(cutRunPrompt(prompt.slice(3), { skip: 0, requestStart: 0, requestEnd: 1, keepTokens: 10_000 })).toBeNull();
  });
});

describe("the summary call", () => {
  const TASK_ID = "7f3c9a2e-5b1d-4c8e-9f0a-1b2c3d4e5f60";
  const DELEGATED_ID = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";
  const BRANCH = `abotica/task-${TASK_ID.slice(0, 8)}`;
  const PR_URL = "https://github.com/acme/shop/pull/42";
  const FILE_URL = "http://localhost:3000/api/files/3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";

  const fixture: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [
        { type: "text", text: "Fix the login bug in acme/shop, and ask Ana to write the docs." },
        { type: "file", url: FILE_URL, mediaType: "image/png", filename: "login-error.png" },
      ],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Thinking about the plan." },
        {
          type: "tool-task_create",
          toolCallId: "c1",
          state: "output-available",
          input: { title: "Fix login bug" },
          output: { id: TASK_ID, title: "Fix login bug", status: "in_progress" },
        },
        {
          type: "tool-task_delegate",
          toolCallId: "c2",
          state: "output-available",
          input: { agent: "ana", title: "Write the docs" },
          output: { taskId: DELEGATED_ID, status: "in_progress", note: "You get a report when it is done." },
        },
        {
          type: "tool-shell_run",
          toolCallId: "c3",
          state: "output-available",
          input: { command: "npm test && git push -u origin HEAD && gh pr create --fill" },
          // A long output: the push and the pull request come at its end.
          output: `${"PASS test\n".repeat(800)}To github.com:acme/shop.git\n * [new branch] ${BRANCH} -> ${BRANCH}\n${PR_URL}`,
        },
        {
          type: "tool-repo_merge",
          toolCallId: "c4",
          state: "approval-requested",
          input: { branch: BRANCH },
          approval: { id: "ap1" },
        },
      ],
    },
  ];

  it("gives the model the ids, branches, URLs, delegated tasks and pending approvals of the history", async () => {
    const text = transcript(await convertToModelMessages(fixture), 100_000);
    for (const kept of [TASK_ID, DELEGATED_ID, BRANCH, PR_URL, FILE_URL, "login-error.png"]) expect(text).toContain(kept);
    expect(text).toContain("[call repo_merge]");
    expect(text).toContain("[this call waits for the user's approval]");
    expect(text).toContain("characters left out");
    expect(text).not.toContain("Thinking about the plan.");
  });

  it("asks to keep them exactly, and secrets by name only", () => {
    const { system } = summaryRequest({ transcript: "...", previousSummary: null, flush: false });
    for (const kept of [
      "task ids",
      "delegated tasks",
      "waiting for the user's approval",
      "branches",
      "pull request URLs",
      "file ids",
    ])
      expect(system).toContain(kept);
    expect(system).toContain("never copy its value");
    for (const section of [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ])
      expect(system).toContain(section);
  });

  it("asks for the memory flush only when the agent may save to memory", () => {
    expect(summaryRequest({ transcript: "...", previousSummary: null, flush: true }).system).toContain("memory_save");
    expect(summaryRequest({ transcript: "...", previousSummary: null, flush: false }).system).not.toContain("memory_save");
  });

  it("updates the previous summary with the new messages", () => {
    const { system, prompt } = summaryRequest({
      transcript: "[User]\nnew",
      previousSummary: "## Goal\nOld goal",
      flush: false,
    });
    expect(prompt).toBe(
      "<previous-summary>\n## Goal\nOld goal\n</previous-summary>\n\n<messages>\n[User]\nnew\n</messages>\n\nUpdate the summary with the messages above.",
    );
    expect(system).toContain("Your summary replaces it");
  });

  it("leaves out the oldest messages when the transcript is over its budget", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first ".repeat(100) },
      { role: "assistant", content: "second ".repeat(100) },
      { role: "user", content: "third" },
    ];
    const text = transcript(messages, 200);
    expect(text).toMatch(/^\[1 earlier messages left out: too long to summarize\]/);
    expect(text).toContain("second");
    expect(text).toContain("[User]\nthird");
  });

  it("opens the summary in the prompt with a prefix, as a user message", () => {
    expect(summaryMessage("## Goal\nShip it")).toEqual({ role: "user", content: `${SUMMARY_PREFIX}\n\n## Goal\nShip it` });
  });
});

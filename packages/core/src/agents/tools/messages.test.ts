import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserError } from "@abotica/i18n";
import { answerQuestion, askQuestion, reportProgress } from "../../tasks/task-messages";
import { messageTools } from "./messages";

/**
 * ask, answer and report_progress: an agent asks and reports about its own task only (the super agent
 * may ask the user about any task), and a refusal goes back to the model as an error.
 */

const OWN = { id: "own-1", assigneeAgentId: "writer", status: "in_progress", projectId: "p1" };
const OTHER = { id: "other-1", assigneeAgentId: "researcher", status: "in_progress", projectId: "p1" };

vi.mock("@abotica/db", () => ({ agents: {}, projects: {}, tasks: {}, db: {} }));
vi.mock("../../tasks/task-messages", () => ({
  askQuestion: vi.fn(async () => ({ comment: { id: "q1" }, delivered: "woke" })),
  answerQuestion: vi.fn(async () => ({ comment: { id: "a1" }, delivered: "steered" })),
  reportProgress: vi.fn(async () => ({ comment: { id: "p1" }, delivered: "stored" })),
}));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  visibleTask: async (_ctx: unknown, id: string) => [OWN, OTHER].find((t) => t.id === id) ?? { error: "not found" },
}));

const ctxOf = (kind: string, id = "writer") => ({
  run: { id: `${id}-run`, conversationId: "c1", taskId: OWN.id },
  agent: { id, slug: id, kind },
  projectId: "p1",
});

const call = (name: string, input: Record<string, unknown>, ctx = ctxOf("specialist")) =>
  messageTools[name]!(ctx as never).execute!(input as never, {
    toolCallId: "call_1",
    messages: [],
    context: {},
  }) as Promise<Record<string, unknown>>;

beforeEach(() => vi.clearAllMocks());

describe("ask", () => {
  it("asks about the run's own task, up to whoever gave it", async () => {
    const result = await call("ask", { question: "Which year?", options: ["2025", "2026"], to: "delegator" });
    expect(askQuestion).toHaveBeenCalledWith(
      OWN.id,
      { question: "Which year?", options: ["2025", "2026"], recommendation: undefined, to: "delegator" },
      { agentId: "writer" },
      { runId: "writer-run" },
    );
    expect(result).toMatchObject({ questionId: "q1", delivered: "woke" });
    expect(result.next).toContain("the answer wakes you");
  });

  it("refuses another agent's task, and the user as addressee for anyone but the super agent", async () => {
    expect((await call("ask", { question: "?", taskId: OTHER.id, to: "delegator" })).error).toContain("your own task");
    expect((await call("ask", { question: "?", to: "user" })).error).toContain("whoever gave you the task");
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("lets the super agent ask the user about any task it sees", async () => {
    await call("ask", { question: "Budget?", taskId: OTHER.id, to: "user" }, ctxOf("orchestrator", "super"));
    expect(vi.mocked(askQuestion).mock.calls[0]![0]).toBe(OTHER.id);
  });

  it("returns a refusal as an error", async () => {
    vi.mocked(askQuestion).mockRejectedValueOnce(new UserError("flow.messages.errors.duplicate"));
    expect((await call("ask", { question: "Which year?", to: "delegator" })).error).toContain("already open");
  });
});

describe("answer", () => {
  it("answers, or forwards", async () => {
    const ctx = ctxOf("manager", "manager");
    expect(
      await call("answer", { questionId: "3f1c6a8e-1d2b-4c5d-9e7f-0a1b2c3d4e5f", answer: "2026", forward: false }, ctx),
    ).toEqual({
      answered: true,
      delivered: "steered",
    });
    expect(
      await call("answer", { questionId: "3f1c6a8e-1d2b-4c5d-9e7f-0a1b2c3d4e5f", answer: "Yours", forward: true }, ctx),
    ).toEqual({ forwarded: true, delivered: "steered" });
    expect(vi.mocked(answerQuestion).mock.calls[1]).toEqual([
      "3f1c6a8e-1d2b-4c5d-9e7f-0a1b2c3d4e5f",
      "Yours",
      { agentId: "manager" },
      { forward: true, runId: "manager-run" },
    ]);
  });
});

describe("report_progress", () => {
  it("reports on the run's own task", async () => {
    expect(await call("report_progress", { summary: "Half", percentDone: 50, needsAttention: false })).toEqual({
      ok: true,
      delivered: "stored",
    });
    expect(vi.mocked(reportProgress).mock.calls[0]![0]).toBe(OWN.id);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  capStreamText,
  capText,
  capToolText,
  cutNotice,
  expiredToolOutputs,
  fullOutputTarget,
  saveFullOutput,
  TOOL_OUTPUT_RETENTION_MS,
  TOOL_TEXT_MAX_CHARS,
  type ToolOutputWorkspace,
} from "./tool-output";
import { collectText } from "./tools/workspace-text";

const RUN_ID = "0b6f3c1e-1111-4222-8333-444455556666";

/** A sandbox that keeps written files in a map, or fails every write with `error`. */
function fakeWorkspace(error?: Error) {
  const written = new Map<string, string>();
  const writeTextFile = vi.fn(async ({ path, content }: { path: string; content: string }) => {
    if (error) throw error;
    written.set(path, content);
  });
  const workspace: ToolOutputWorkspace = { sandbox: { writeTextFile }, runId: RUN_ID };
  return { workspace, written, writeTextFile };
}

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

describe("capText", () => {
  it("returns a text within the limit as it is", () => {
    const text = "x".repeat(TOOL_TEXT_MAX_CHARS);
    expect(capText(text)).toEqual({ text, cut: null });
  });

  it("keeps half of the limit from each end, with a notice in between", () => {
    const text = `${"a".repeat(100)}${"m".repeat(50)}${"z".repeat(100)}`;
    const capped = capText(text, 200, "tool-output/run/call.txt");
    expect(capped.cut).toEqual({ totalChars: 250, keptHead: 100, keptTail: 100 });
    expect(capped.text).toBe(
      `${"a".repeat(100)}\n[... 50 characters cut. Full output in your workspace: tool-output/run/call.txt ...]\n${"z".repeat(100)}`,
    );
  });

  it("gives the odd character of the limit to the tail", () => {
    expect(capText("abcdefghij", 5).cut).toEqual({ totalChars: 10, keptHead: 2, keptTail: 3 });
  });

  it("says the middle was not kept when there is no file", () => {
    expect(capText("abcdefghij", 4).text).toBe(`ab\n${cutNotice(6, null)}\nij`);
    expect(cutNotice(6, null)).toContain("not kept");
    expect(cutNotice(6, null)).toContain("narrower arguments");
  });

  it("leaves a 200k text at about the limit", () => {
    const capped = capText("y".repeat(200_000));
    expect(capped.cut).toEqual({ totalChars: 200_000, keptHead: 15_000, keptTail: 15_000 });
    expect(capped.text.length).toBeLessThan(TOOL_TEXT_MAX_CHARS + 200);
  });
});

describe("fullOutputTarget", () => {
  it("is null without a workspace", () => {
    expect(fullOutputTarget(null, { toolCallId: "call_1" })).toBeNull();
    expect(fullOutputTarget(undefined, { toolCallId: "call_1" })).toBeNull();
  });

  it("names a file per run and tool call, and per stream of a command", () => {
    const { workspace } = fakeWorkspace();
    const signal = new AbortController().signal;
    expect(fullOutputTarget(workspace, { toolCallId: "call_1", abortSignal: signal })).toEqual({
      sandbox: workspace.sandbox,
      path: `tool-output/${RUN_ID}/call_1.txt`,
      abortSignal: signal,
    });
    expect(fullOutputTarget(workspace, { toolCallId: "call_1" }, "stderr")?.path).toBe(
      `tool-output/${RUN_ID}/call_1.stderr.txt`,
    );
  });

  it("keeps a tool call id from leaving the run's folder", () => {
    const { workspace } = fakeWorkspace();
    expect(fullOutputTarget(workspace, { toolCallId: "../../etc/passwd" })?.path).toBe(`tool-output/${RUN_ID}/passwd.txt`);
    expect(fullOutputTarget(workspace, { toolCallId: "functions.shell:0" })?.path).toBe(
      `tool-output/${RUN_ID}/functions.shell_0.txt`,
    );
  });
});

describe("saveFullOutput", () => {
  it("writes the text and returns its path", async () => {
    const { workspace, written } = fakeWorkspace();
    const target = fullOutputTarget(workspace, { toolCallId: "c1" })!;
    expect(await saveFullOutput(target, "all of it")).toBe(target.path);
    expect(written.get(target.path)).toBe("all of it");
  });

  it("returns null when the write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspace } = fakeWorkspace(new Error("disk full"));
    expect(await saveFullOutput(fullOutputTarget(workspace, { toolCallId: "c1" })!, "text")).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails when the run was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { workspace } = fakeWorkspace(new Error("aborted"));
    const target = fullOutputTarget(workspace, { toolCallId: "c1", abortSignal: controller.signal })!;
    await expect(saveFullOutput(target, "text")).rejects.toThrow("aborted");
  });
});

describe("capToolText", () => {
  const long = `${"h".repeat(20_000)}${"m".repeat(10_000)}${"t".repeat(20_000)}`;

  it("saves nothing for a text within the limit", async () => {
    const { workspace, writeTextFile } = fakeWorkspace();
    const capped = await capToolText("short", fullOutputTarget(workspace, { toolCallId: "c1" }));
    expect(capped).toEqual({ text: "short", cut: null, file: null });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("saves the full text of a cut one and names the file in the notice", async () => {
    const { workspace, written } = fakeWorkspace();
    const capped = await capToolText(long, fullOutputTarget(workspace, { toolCallId: "c1" }));
    const file = `tool-output/${RUN_ID}/c1.txt`;
    expect(capped.file).toBe(file);
    expect(written.get(file)).toBe(long);
    expect(capped.text).toContain(`[... 20000 characters cut. Full output in your workspace: ${file} ...]`);
    expect(capped.text.startsWith("h".repeat(15_000))).toBe(true);
    expect(capped.text.endsWith("t".repeat(15_000))).toBe(true);
  });

  it("cuts without a file when the run has no workspace", async () => {
    const capped = await capToolText(long, null);
    expect(capped.file).toBeNull();
    expect(capped.text).toContain(cutNotice(20_000, null));
  });

  it("cuts without a file when saving fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { workspace } = fakeWorkspace(new Error("disk full"));
    const capped = await capToolText(long, fullOutputTarget(workspace, { toolCallId: "c1" }));
    expect(capped.file).toBeNull();
    expect(capped.text).toContain("not kept");
    error.mockRestore();
  });
});

describe("capStreamText", () => {
  it("saves the whole stream when it fit in the byte limit", async () => {
    const { workspace, written } = fakeWorkspace();
    const text = "line\n".repeat(10_000);
    const collected = await collectText(streamOf(text), TOOL_TEXT_MAX_CHARS, 1024 * 1024);
    const capped = await capStreamText(collected, fullOutputTarget(workspace, { toolCallId: "c1" }, "stdout"));
    expect(capped.file).toBe(`tool-output/${RUN_ID}/c1.stdout.txt`);
    expect(written.get(capped.file!)).toBe(text);
  });

  it("says in the saved file when the stream went on past the byte limit", async () => {
    const { workspace, written } = fakeWorkspace();
    const collected = await collectText(streamOf("z".repeat(50_000)), TOOL_TEXT_MAX_CHARS, 40_000);
    const capped = await capStreamText(collected, fullOutputTarget(workspace, { toolCallId: "c1" }, "stdout"));
    const saved = written.get(capped.file!)!;
    expect(saved.startsWith("z".repeat(40_000))).toBe(true);
    expect(saved).toContain("this file holds its start");
  });

  it("returns a short stream as it is", async () => {
    const { workspace, writeTextFile } = fakeWorkspace();
    const collected = await collectText(streamOf("ok\n"), TOOL_TEXT_MAX_CHARS, 1024 * 1024);
    expect(await capStreamText(collected, fullOutputTarget(workspace, { toolCallId: "c1" }, "stdout"))).toEqual({
      text: "ok\n",
      cut: null,
      file: null,
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe("expiredToolOutputs", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("removes the folders of runs past the retention period and of runs that are gone", () => {
    const ids = ["old", "recent", "running", "gone"];
    const runs = [
      { id: "old", finishedAt: ago(TOOL_OUTPUT_RETENTION_MS + 1) },
      { id: "recent", finishedAt: ago(TOOL_OUTPUT_RETENTION_MS - 1) },
      { id: "running", finishedAt: null },
    ];
    expect(expiredToolOutputs(ids, runs, now)).toEqual(["old", "gone"]);
  });

  it("keeps folders for 7 days", () => {
    expect(TOOL_OUTPUT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

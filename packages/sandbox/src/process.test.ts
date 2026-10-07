import { describe, expect, it } from "vitest";
import { collectText, runCommand, trimPartialUtf8 } from "./process";
import type { Workspace } from "./types";

const encoder = new TextEncoder();

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

describe("collectText", () => {
  it("keeps everything under the limit", async () => {
    expect(await collectText(streamOf(["hello ", "world"]), 100)).toEqual({ text: "hello world", truncated: false });
  });

  it("keeps the head and drains the rest past the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 50) return controller.close();
        controller.enqueue(encoder.encode("0123456789"));
      },
    });
    expect(await collectText(stream, 25)).toEqual({ text: "0123456789012345678901234", truncated: true });
    expect(pulled).toBe(51);
  });

  it("does not leave half a character at the cut", async () => {
    // "é" is two bytes; the limit falls between them.
    const result = await collectText(streamOf(["abcé"]), 4);
    expect(result).toEqual({ text: "abc", truncated: true });
  });
});

describe("trimPartialUtf8", () => {
  const bytes = (text: string) => encoder.encode(text);

  it("keeps complete text", () => {
    expect(trimPartialUtf8(bytes("añ€😀"))).toEqual(bytes("añ€😀"));
  });

  it.each([1, 2, 3])("drops %i bytes of a cut four-byte character", (kept) => {
    const full = bytes("a😀");
    expect(trimPartialUtf8(full.subarray(0, 1 + kept))).toEqual(bytes("a"));
  });

  it("drops a cut three-byte character", () => {
    expect(trimPartialUtf8(bytes("x€").subarray(0, 3))).toEqual(bytes("x"));
  });
});

describe("runCommand", () => {
  const workspace = (exitCode: number, timedOut: boolean, stdout: string[]): Workspace => ({
    key: "test",
    paths: { workspace: "/w", bundles: "/b", home: "/w/.home" },
    async exec() {
      return {
        stdin: null,
        stdout: streamOf(stdout),
        stderr: streamOf(["warn"]),
        wait: async () => ({ exitCode, timedOut }),
        kill: async () => {},
      };
    },
  });

  it("collects both streams", async () => {
    const result = await runCommand(workspace(0, false, ["out"]), { command: "x", egress: [] });
    expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "warn", timedOut: false, truncated: false });
  });

  it("reports 124 on timeout and flags truncation", async () => {
    const result = await runCommand(workspace(143, true, ["abcdef"]), { command: "x", egress: [], maxOutputBytes: 3 });
    expect(result).toMatchObject({ exitCode: 124, stdout: "abc", timedOut: true, truncated: true });
  });
});

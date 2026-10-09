import type { Experimental_SandboxSession } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../context";

/** The tools import the database client, which needs a URL. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./workspace");
}

afterEach(() => vi.unstubAllEnvs());

/** A PNG header of the given size, padded to `length` bytes. */
function png(width: number, height: number, length = 64) {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A sandbox whose files are the given bytes; writes are recorded. */
function sandboxWith(files: Record<string, Uint8Array | string>) {
  const writes: Record<string, string> = {};
  const sandbox = {
    readFile: async ({ path }: { path: string }) => {
      const file = files[path];
      if (file === undefined) return null;
      const bytes = typeof file === "string" ? new TextEncoder().encode(file) : file;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    writeTextFile: async ({ path, content }: { path: string; content: string }) => {
      writes[path] = content;
    },
  } as unknown as Experimental_SandboxSession;
  return { sandbox, writes };
}

const ctx = { repos: [], instructionFolders: new Set<string>() } as unknown as RunContext;
const call = (sandbox: Experimental_SandboxSession) => ({
  toolCallId: "call-1",
  messages: [],
  context: {},
  experimental_sandbox: sandbox,
});

describe("file_read", () => {
  it("returns an image as base64 with its type and size", async () => {
    const { workspaceTools } = await load();
    const bytes = png(1280, 720);
    const { sandbox } = sandboxWith({ "shot.png": bytes });
    const result = await workspaceTools.file_read!(ctx).execute!({ path: "shot.png" }, call(sandbox));
    expect(result).toEqual({
      path: "shot.png",
      mediaType: "image/png",
      bytes: 64,
      width: 1280,
      height: 720,
      image: Buffer.from(bytes).toString("base64"),
    });
  });

  it("asks for a smaller copy of an image providers would refuse", async () => {
    const { workspaceTools } = await load();
    const { sandbox } = sandboxWith({ "big.png": png(9000, 9000, 4_000_000) });
    const result = await workspaceTools.file_read!(ctx).execute!({ path: "big.png" }, call(sandbox));
    expect(result).toEqual({ error: expect.stringContaining("Save a smaller copy") });
  });

  it("refuses other binary files", async () => {
    const { workspaceTools } = await load();
    const { sandbox } = sandboxWith({ "data.bin": new Uint8Array([0, 1, 2, 0, 0, 255, 254, 0]) });
    const result = await workspaceTools.file_read!(ctx).execute!({ path: "data.bin" }, call(sandbox));
    expect(result).toEqual({ error: expect.stringContaining("is not a text file or an image") });
  });

  it("still reads text, SVG included", async () => {
    const { workspaceTools } = await load();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const { sandbox } = sandboxWith({ "logo.svg": svg });
    const result = await workspaceTools.file_read!(ctx).execute!({ path: "logo.svg" }, call(sandbox));
    expect(result).toEqual({ path: "logo.svg", content: svg, totalLines: 1 });
  });

  it("shows the model an image as a file part after a line naming it", async () => {
    const { workspaceTools } = await load();
    const tool = workspaceTools.file_read!(ctx);
    const output = { path: "out/shot.png", mediaType: "image/png", bytes: 20_480, width: 800, height: 600, image: "iVBOR" };
    expect(await tool.toModelOutput!({ toolCallId: "call-1", input: { path: "out/shot.png" }, output })).toEqual({
      type: "content",
      value: [
        { type: "text", text: "out/shot.png: image/png, 800x600 px, 20 KB." },
        { type: "file", mediaType: "image/png", filename: "shot.png", data: { type: "data", data: "iVBOR" } },
      ],
    });
  });

  it("sends every other result as JSON", async () => {
    const { workspaceTools } = await load();
    const tool = workspaceTools.file_read!(ctx);
    const output = { path: "a.txt", content: "hi", totalLines: 1 };
    expect(await tool.toModelOutput!({ toolCallId: "call-1", input: { path: "a.txt" }, output })).toEqual({
      type: "json",
      value: output,
    });
    const error = { error: "File a.txt does not exist." };
    expect(await tool.toModelOutput!({ toolCallId: "call-1", input: { path: "a.txt" }, output: error })).toEqual({
      type: "json",
      value: error,
    });
  });
});

describe("file_edit", () => {
  it("refuses an image as not text", async () => {
    const { workspaceTools } = await load();
    const { sandbox, writes } = sandboxWith({ "shot.png": png(10, 10) });
    const result = await workspaceTools.file_edit!(ctx).execute!(
      { path: "shot.png", oldText: "a", newText: "b" },
      call(sandbox),
    );
    expect(result).toEqual({ error: expect.stringMatching(/is not a text file\. /) });
    expect(writes).toEqual({});
  });
});

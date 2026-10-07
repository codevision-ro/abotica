import { describe, expect, it } from "vitest";
import { applyEdit, collectText, decodeText, HeadTailText, readAtMost, sliceLines } from "./workspace-text";

const streamOf = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c);
      controller.close();
    },
  });

describe("applyEdit", () => {
  it("replaces a unique occurrence", () => {
    expect(applyEdit("a = 1\nb = 2\n", "b = 2", "b = 3")).toEqual({ content: "a = 1\nb = 3\n", replacements: 1 });
  });

  it("refuses ambiguous text unless replaceAll is set", () => {
    const result = applyEdit("x x x", "x", "y");
    expect("error" in result && result.error).toContain("3 times");
    expect(applyEdit("x x x", "x", "y", true)).toEqual({ content: "y y y", replacements: 3 });
  });

  it("reports missing and empty oldText", () => {
    expect("error" in applyEdit("abc", "zzz", "y")).toBe(true);
    expect("error" in applyEdit("abc", "", "y")).toBe(true);
  });

  it("keeps replacement patterns literal", () => {
    expect(applyEdit("price", "price", "$& $1 $$")).toEqual({ content: "$& $1 $$", replacements: 1 });
  });
});

describe("sliceLines", () => {
  it("counts lines without the trailing newline", () => {
    expect(sliceLines("a\nb\nc\n").totalLines).toBe(3);
    expect(sliceLines("a\nb\nc").totalLines).toBe(3);
    expect(sliceLines("").totalLines).toBe(0);
  });

  it("returns an inclusive, clamped range", () => {
    expect(sliceLines("1\n2\n3\n4\n", 2, 3).content).toBe("2\n3");
    expect(sliceLines("1\n2\n3\n", 2, 99).content).toBe("2\n3");
    expect(sliceLines("1\n2\n", 5).content).toBe("");
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 and rejects binary", () => {
    expect(decodeText(new TextEncoder().encode("ăîșț ok"))).toBe("ăîșț ok");
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe("HeadTailText", () => {
  const notice = (omitted: number) => `[${omitted} cut]`;

  it("keeps short output whole", () => {
    const out = new HeadTailText(5, 5);
    out.push("hello");
    out.push(" you");
    expect(out.text(notice)).toBe("hello you");
    expect(out.cut()).toBeNull();
  });

  it("keeps the start and the end of long output", () => {
    const out = new HeadTailText(4, 4);
    for (const chunk of ["abcd", "efgh", "ijkl", "mnop"]) out.push(chunk);
    expect(out.text(notice)).toBe("abcd\n[8 cut]\nmnop");
    expect(out.cut()).toEqual({ totalChars: 16, keptHead: 4, keptTail: 4 });
  });

  it("keeps a text exactly at the limit whole", () => {
    const out = new HeadTailText(2, 2);
    out.push("abcd");
    expect(out.text(notice)).toBe("abcd");
    expect(out.cut()).toBeNull();
  });
});

describe("stream helpers", () => {
  it("collects text across split multi-byte characters", async () => {
    const bytes = new TextEncoder().encode("ș");
    const collected = await collectText(streamOf(bytes.slice(0, 1), bytes.slice(1), "!"), 100, 100);
    expect(collected.view.text(String)).toBe("ș!");
    expect(collected.full()).toBe("ș!");
    expect(collected.complete).toBe(true);
  });

  it("keeps the full text up to a byte limit next to the head and tail view", async () => {
    const collected = await collectText(streamOf("abcd", "efgh", "ijkl"), 4, 6);
    expect(collected.view.text((n) => `[${n}]`)).toBe("ab\n[8]\nkl");
    expect(collected.full()).toBe("abcdef");
    expect(collected.complete).toBe(false);
  });

  it("is complete when the stream ends exactly at the byte limit", async () => {
    const collected = await collectText(streamOf("abc", "def"), 100, 6);
    expect(collected.full()).toBe("abcdef");
    expect(collected.complete).toBe(true);
  });

  it("reads up to a byte limit", async () => {
    expect(await readAtMost(streamOf("abc", "def"), 6)).toEqual(new TextEncoder().encode("abcdef"));
    expect(await readAtMost(streamOf("abc", "def"), 5)).toBeNull();
  });
});

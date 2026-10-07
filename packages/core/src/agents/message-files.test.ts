import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { fileUrl } from "../files/file-types";
import {
  clipText,
  type FileInfo,
  type FileStore,
  formatSize,
  IMAGE_INLINE_MAX_BYTES,
  INLINE_MAX_FILES,
  TEXT_INLINE_MAX_CHARS,
  withModelFiles,
} from "./message-files";

const MB = 1024 * 1024;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type FakeFile = FileInfo & { data: Uint8Array | null };

const file = (n: number, name: string, mimeType: string, data: Uint8Array | null, size = data?.byteLength ?? 0) => ({
  id: uuid(n),
  name,
  mimeType,
  size,
  data,
});

/** A store over fake files that records which bytes were read. */
function fakeStore(files: FakeFile[]): FileStore & { reads: string[] } {
  const byId = new Map(files.map((f) => [f.id, f]));
  const reads: string[] = [];
  return {
    reads,
    get: async (id) => {
      const f = byId.get(id);
      return f ? { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size } : null;
    },
    read: async (id) => {
      reads.push(id);
      return byId.get(id)?.data ?? null;
    },
  };
}

const userMessage = (id: string, ...files: { id: string; name: string; mimeType: string }[]): UIMessage => ({
  id,
  role: "user",
  parts: [
    { type: "text", text: "Look at this" },
    ...files.map((f) => ({ type: "file" as const, url: fileUrl(f.id), mediaType: f.mimeType, filename: f.name })),
  ],
});

const readsAll = async () => true;
const texts = (message: UIMessage | undefined) =>
  message?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).slice(1) ?? [];

describe("formatSize", () => {
  it("uses the largest fitting unit", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(2 * MB)).toBe("2 MB");
    expect(formatSize(3.25 * 1024 * MB)).toBe("3.3 GB");
  });
});

describe("clipText", () => {
  it("returns short text whole", () => {
    expect(clipText(new TextEncoder().encode("héllo"), 10)).toEqual({ text: "héllo", cut: false });
  });

  it("cuts after the limit", () => {
    expect(clipText(new TextEncoder().encode("abcdef"), 4)).toEqual({ text: "abcd", cut: true });
  });

  it("decodes only the bytes the limit can need", () => {
    expect(clipText(new TextEncoder().encode("ab" + "x".repeat(100)), 2)).toEqual({ text: "ab", cut: true });
  });
});

describe("withModelFiles", () => {
  const pdf = file(1, "report.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70]));
  const notes = file(2, "notes.md", "text/markdown", new TextEncoder().encode("# Notes\nhello"));
  const sheet = file(
    3,
    "data.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    new Uint8Array(10),
  );

  it("puts a note before an image or PDF and sends its bytes", async () => {
    const store = fakeStore([pdf]);
    const [message] = await withModelFiles([userMessage("m1", pdf)], { store, workspace: true, readsDirectly: readsAll });
    expect(message?.parts).toEqual([
      { type: "text", text: "Look at this" },
      {
        type: "text",
        text: '[Attached file "report.pdf" (application/pdf, 4 B), in the workspace at inputs/00000000/report.pdf.]',
      },
      { type: "file", mediaType: "application/pdf", filename: "report.pdf", url: "data:application/pdf;base64,JVBERg==" },
    ]);
  });

  it("shows a text file's content in the note", async () => {
    const store = fakeStore([notes]);
    const [message] = await withModelFiles([userMessage("m1", notes)], {
      store,
      workspace: false,
      readsDirectly: readsAll,
    });
    expect(texts(message)).toEqual(['[Attached file "notes.md" (text/markdown, 13 B). Its content:]\n# Notes\nhello']);
  });

  it("clips long text and says where the rest is", async () => {
    const long = file(4, "log.txt", "text/plain", new TextEncoder().encode("x".repeat(TEXT_INLINE_MAX_CHARS + 5)));
    const store = fakeStore([long]);
    const [withWorkspace] = await withModelFiles([userMessage("m1", long)], {
      store,
      workspace: true,
      readsDirectly: readsAll,
    });
    expect(texts(withWorkspace)[0]).toMatch(/\[Cut after 20,000 characters; the whole file is in the workspace\.\]$/);
    const [without] = await withModelFiles([userMessage("m1", long)], { store, workspace: false, readsDirectly: readsAll });
    expect(texts(without)[0]).toMatch(/x\n\[Cut after 20,000 characters\.\]$/);
  });

  it("gives other files a note only, without reading them", async () => {
    const store = fakeStore([sheet]);
    const messages = [userMessage("m1", sheet)];
    const [inWorkspace] = await withModelFiles(messages, { store, workspace: true, readsDirectly: readsAll });
    expect(texts(inWorkspace)).toEqual([
      '[Attached file "data.xlsx" (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 10 B), in the workspace at inputs/00000000/data.xlsx. Open it with the workspace tools if you need its content.]',
    ]);
    const [noWorkspace] = await withModelFiles(messages, { store, workspace: false, readsDirectly: readsAll });
    expect(texts(noWorkspace)[0]).toMatch(/Its content is not available in this run\.\]$/);
    expect(store.reads).toEqual([]);
  });

  it("does not load images or PDFs no model of the run reads", async () => {
    const store = fakeStore([pdf]);
    const [message] = await withModelFiles([userMessage("m1", pdf)], {
      store,
      workspace: false,
      readsDirectly: async (type) => type.startsWith("image/"),
    });
    expect(message?.parts.some((p) => p.type === "file")).toBe(false);
    expect(store.reads).toEqual([]);
  });

  it("keeps files over the size limit out", async () => {
    const big = file(5, "photo.png", "image/png", null, IMAGE_INLINE_MAX_BYTES + 1);
    const store = fakeStore([big]);
    const [message] = await withModelFiles([userMessage("m1", big)], { store, workspace: true, readsDirectly: readsAll });
    expect(texts(message)[0]).toContain("Too large to show here. Open it with the workspace tools");
    expect(store.reads).toEqual([]);
  });

  it("sends the newest files first and stops at the total budget", async () => {
    const pdfs = [6, 7, 8].map((n) => file(n, `doc${n}.pdf`, "application/pdf", new Uint8Array(1), 7 * MB));
    const store = fakeStore(pdfs);
    const messages = pdfs.map((f, i) => userMessage(`m${i}`, f));
    const result = await withModelFiles(messages, { store, workspace: false, readsDirectly: readsAll });
    expect(result.map((m) => m.parts.some((p) => p.type === "file"))).toEqual([false, true, true]);
    expect(texts(result[0])[0]).toContain("No longer shown here, to leave room for newer files.");
    expect(store.reads.sort()).toEqual([uuid(7), uuid(8)]);
  });

  it("sends at most the file count limit", async () => {
    const images = Array.from({ length: INLINE_MAX_FILES + 2 }, (_, n) =>
      file(100 + n, `i${n}.png`, "image/png", new Uint8Array(1)),
    );
    const store = fakeStore(images);
    const [message] = await withModelFiles([userMessage("m1", ...images)], {
      store,
      workspace: false,
      readsDirectly: readsAll,
    });
    const sent = message!.parts.flatMap((p) => (p.type === "file" ? [p.filename] : []));
    expect(sent).toHaveLength(INLINE_MAX_FILES);
    expect(sent[0]).toBe("i2.png");
  });

  it("shows a file attached twice only where it appears last", async () => {
    const store = fakeStore([pdf]);
    const read = vi.spyOn(store, "read");
    const result = await withModelFiles([userMessage("m1", pdf), userMessage("m2", pdf)], {
      store,
      workspace: false,
      readsDirectly: readsAll,
    });
    expect(texts(result[0])).toEqual([
      '[Attached file "report.pdf" (application/pdf, 4 B). Shown again in a later message.]',
    ]);
    expect(result[1]?.parts.some((p) => p.type === "file")).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("says so when the stored file or its bytes are gone", async () => {
    const lost = file(9, "lost.pdf", "application/pdf", null, 100);
    const store = fakeStore([lost]);
    const deleted = { id: uuid(10), name: "deleted.png", mimeType: "image/png" };
    const [message] = await withModelFiles([userMessage("m1", lost, deleted)], {
      store,
      workspace: true,
      readsDirectly: readsAll,
    });
    expect(texts(message)).toEqual([
      '[Attached file "lost.pdf" (application/pdf): the stored file no longer exists.]',
      '[Attached file "deleted.png" (image/png): the stored file no longer exists.]',
    ]);
  });

  it("keeps a note but no bytes for links that are not stored files", async () => {
    const store = fakeStore([]);
    const message: UIMessage = {
      id: "m1",
      role: "user",
      parts: [{ type: "file", url: "data:image/png;base64,iVBORw==", mediaType: "image/png", filename: "old.png" }],
    };
    const [result] = await withModelFiles([message], { store, workspace: true, readsDirectly: readsAll });
    expect(result?.parts).toEqual([
      { type: "text", text: '[Attached file "old.png" (image/png): not a stored file, so its content is not available.]' },
    ]);
  });

  it("leaves assistant messages and messages without files as they are", async () => {
    const plain: UIMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };
    const answer: UIMessage = {
      id: "m2",
      role: "assistant",
      parts: [{ type: "file", url: "data:image/png;base64,iVBORw==", mediaType: "image/png" }],
    };
    const result = await withModelFiles([plain, answer, userMessage("m3", pdf)], {
      store: fakeStore([pdf]),
      workspace: false,
      readsDirectly: readsAll,
    });
    expect(result[0]).toBe(plain);
    expect(result[1]).toBe(answer);
  });
});

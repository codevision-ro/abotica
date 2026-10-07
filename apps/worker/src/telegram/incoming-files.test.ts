import { afterEach, describe, expect, it, vi } from "vitest";
import { incomingFileName, mediaGroupCollector } from "./incoming-files";

describe("incomingFileName", () => {
  it("keeps the name Telegram gives", () => {
    expect(incomingFileName("report.pdf", "application/pdf", "file")).toBe("report.pdf");
    expect(incomingFileName("  notes.txt ", undefined, "file")).toBe("notes.txt");
  });

  it("adds the extension of the media type to the fallback", () => {
    expect(incomingFileName(undefined, "image/jpeg", "photo")).toBe("photo.jpg");
    expect(incomingFileName("", "application/pdf", "file")).toBe("file.pdf");
    expect(incomingFileName("   ", "audio/mpeg", "file")).toBe("file.mp3");
  });

  it("falls back to the bare name for unknown or missing media types", () => {
    expect(incomingFileName(undefined, "application/x-unknown", "file")).toBe("file");
    expect(incomingFileName(undefined, undefined, "file")).toBe("file");
  });
});

describe("mediaGroupCollector", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes an album once, in order, after the last item", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const collect = mediaGroupCollector<number>(flush, 1_000);
    collect("a", 1);
    vi.advanceTimersByTime(900);
    collect("a", 2);
    vi.advanceTimersByTime(900);
    collect("a", 3);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("keeps albums apart and starts over after a flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const collect = mediaGroupCollector<string>(flush, 500);
    collect("a", "a1");
    collect("b", "b1");
    collect("a", "a2");
    vi.advanceTimersByTime(500);
    expect(flush.mock.calls).toEqual([[["b1"]], [["a1", "a2"]]]);
    collect("a", "a3");
    vi.advanceTimersByTime(500);
    expect(flush).toHaveBeenLastCalledWith(["a3"]);
  });
});

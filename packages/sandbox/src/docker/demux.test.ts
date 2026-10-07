import { PassThrough } from "node:stream";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { demuxDockerStream } from "./demux";

const frame = (type: number, payload: string) => {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

describe("demuxDockerStream", () => {
  it("routes frames to stdout and stderr, across chunk boundaries", async () => {
    const source = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    demuxDockerStream(source, stdout, stderr);
    const all = Buffer.concat([frame(1, "hello "), frame(2, "oops"), frame(1, "world"), frame(0, "ignored")]);
    for (let i = 0; i < all.length; i += 3) source.write(all.subarray(i, i + 3));
    source.end();
    expect(await text(stdout)).toBe("hello world");
    expect(await text(stderr)).toBe("oops");
  });

  it("pauses the source while an output is full", async () => {
    const source = new PassThrough();
    const stdout = new PassThrough({ highWaterMark: 4 });
    const stderr = new PassThrough();
    demuxDockerStream(source, stdout, stderr);
    source.write(frame(1, "0123456789"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.isPaused()).toBe(true);
    const out = text(stdout);
    source.end(frame(1, "!"));
    expect(await out).toBe("0123456789!");
    expect(await text(stderr)).toBe("");
  });

  it("ends both outputs when the source fails", async () => {
    const source = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    demuxDockerStream(source, stdout, stderr);
    source.write(frame(1, "partial"));
    source.destroy(new Error("connection reset"));
    expect(await text(stdout)).toBe("partial");
    expect(await text(stderr)).toBe("");
  });
});

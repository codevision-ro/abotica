import { describe, expect, it } from "vitest";
import { imageMediaType, imageSize } from "./image-info";

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

const png = (width: number, height: number) =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(width), u32be(height), [8, 6, 0, 0, 0]);

const gif = (width: number, height: number) => bytes("GIF89a", u16le(width), u16le(height), [0xf7, 0, 0]);

/** A JPEG with an APP0 segment, a Huffman table (C4, not a frame), fill bytes, then the frame. */
const jpeg = (width: number, height: number, sof = 0xc0) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0],
    u16be(16),
    "JFIF",
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc4],
    u16be(5),
    [0, 1, 2],
    [0xff, 0xff, sof],
    u16be(17),
    [8],
    u16be(height),
    u16be(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );

const riff = (chunk: string, data: number[]) => bytes("RIFF", u32be(0), "WEBP", chunk, u32be(data.length), data);

const webpLossy = (width: number, height: number) =>
  riff("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);

function webpLossless(width: number, height: number) {
  const w = width - 1;
  const h = height - 1;
  return riff("VP8L", [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f, 0, 0]);
}

const webpExtended = (width: number, height: number) =>
  riff("VP8X", [0x10, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1), 0, 0]);

describe("imageMediaType", () => {
  it("recognizes PNG, JPEG, GIF and WebP by their signature", () => {
    expect(imageMediaType(png(1, 1))).toBe("image/png");
    expect(imageMediaType(jpeg(1, 1))).toBe("image/jpeg");
    expect(imageMediaType(gif(1, 1))).toBe("image/gif");
    expect(imageMediaType(bytes("GIF87a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(imageMediaType(webpLossy(1, 1))).toBe("image/webp");
  });

  it("returns null for text, SVG, other RIFF files and short input", () => {
    expect(imageMediaType(bytes("hello world"))).toBeNull();
    expect(imageMediaType(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(imageMediaType(bytes("RIFF", u32be(0), "WAVEfmt "))).toBeNull();
    expect(imageMediaType(bytes([0x89, 0x50]))).toBeNull();
    expect(imageMediaType(new Uint8Array())).toBeNull();
  });
});

describe("imageSize", () => {
  it("reads PNG and GIF headers", () => {
    expect(imageSize(png(1280, 720), "image/png")).toEqual({ width: 1280, height: 720 });
    expect(imageSize(png(70_000, 3), "image/png")).toEqual({ width: 70_000, height: 3 });
    expect(imageSize(gif(640, 480), "image/gif")).toEqual({ width: 640, height: 480 });
  });

  it("finds the JPEG frame past other segments and fill bytes", () => {
    expect(imageSize(jpeg(1920, 1080), "image/jpeg")).toEqual({ width: 1920, height: 1080 });
    // Progressive (SOF2) and lossless (SOF3) frames count; C4, C8 and CC are not frames.
    expect(imageSize(jpeg(800, 600, 0xc2), "image/jpeg")).toEqual({ width: 800, height: 600 });
    expect(imageSize(jpeg(800, 600, 0xc3), "image/jpeg")).toEqual({ width: 800, height: 600 });
    expect(imageSize(jpeg(800, 600, 0xc8), "image/jpeg")).toBeNull();
    expect(imageSize(jpeg(800, 600, 0xcc), "image/jpeg")).toBeNull();
  });

  it("reads each kind of WebP", () => {
    expect(imageSize(webpLossy(1024, 768), "image/webp")).toEqual({ width: 1024, height: 768 });
    expect(imageSize(webpLossless(1000, 16_384), "image/webp")).toEqual({ width: 1000, height: 16_384 });
    expect(imageSize(webpLossless(1, 1), "image/webp")).toEqual({ width: 1, height: 1 });
    expect(imageSize(webpExtended(4000, 3000), "image/webp")).toEqual({ width: 4000, height: 3000 });
  });

  it("returns null for headers cut short or broken", () => {
    expect(imageSize(png(10, 10).subarray(0, 20), "image/png")).toBeNull();
    expect(imageSize(png(0, 10), "image/png")).toBeNull();
    expect(imageSize(jpeg(10, 10).subarray(0, 33), "image/jpeg")).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]), "image/jpeg")).toBeNull();
    expect(imageSize(webpLossy(10, 10).subarray(0, 25), "image/webp")).toBeNull();
    expect(imageSize(riff("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/webp")).toBeNull();
  });
});

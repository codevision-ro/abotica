/**
 * The kind and size of an image from its first bytes, so file_read can hand a picture to the model
 * as a picture and say how large it is. Only the formats every vision model takes (PNG, JPEG, GIF,
 * WebP); SVG is text and is read as such. Pure, no server imports.
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ImageSize = { width: number; height: number };

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");

/** The image type the bytes start with, by signature rather than file name; null for anything else. */
export function imageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);

const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);

/** PNG: width and height open the IHDR chunk, which always comes first. */
function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !startsWith(b, ascii("IHDR"), 12)) return null;
  return sized(be32(b, 16), be32(b, 20));
}

function gifSize(b: Uint8Array): ImageSize | null {
  return b.length < 10 ? null : sized(le16(b, 6), le16(b, 8));
}

/**
 * JPEG: walks the segments to the first start of frame (SOF0 to SOF15). C4 (Huffman tables), C8
 * (reserved) and CC (arithmetic coding) share that range but are not frames.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Markers without a length: TEM, restart markers, start and end of image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return i + 9 <= b.length ? sized(be16(b, i + 7), be16(b, i + 5)) : null;
    }
    i += 2 + length;
  }
  return null;
}

/** WebP: the first chunk is lossy (VP8), lossless (VP8L) or extended (VP8X, which holds the canvas size). */
function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 25) return null;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height.
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    // Signature 0x2F, then width - 1 and height - 1 in 14 bits each.
    if (b[20] !== 0x2f) return null;
    const width = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const height = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return sized(width, height);
  }
  if (chunk === "VP8X") {
    // Flags (4 bytes), then canvas width - 1 and height - 1 in 24 bits each.
    if (b.length < 30) return null;
    return sized(1 + le24(b, 24), 1 + le24(b, 27));
  }
  return null;
}

/** Width and height in pixels from the image's header; null when the header is cut short or unknown. */
export function imageSize(bytes: Uint8Array, type: ImageMediaType): ImageSize | null {
  switch (type) {
    case "image/png":
      return pngSize(bytes);
    case "image/gif":
      return gifSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
  }
}

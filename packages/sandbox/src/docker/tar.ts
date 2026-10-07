/**
 * Minimal tar writer (ustar, with a pax header for paths longer than 100 bytes), enough to stream
 * bundle files into a container over exec stdin.
 */
export type TarEntry =
  { type: "directory"; path: string; mode: number } | { type: "file"; path: string; mode: number; content: Uint8Array };

const BLOCK = 512;

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

function header(path: string, typeflag: string, mode: number, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(path, 0, 100, "utf8");
  block.write(octal(mode & 0o7777, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(mtime, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(typeflag, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write("root", 265, "ascii");
  block.write("root", 297, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** A pax record is `<length> <key>=<value>\n`, where length counts the whole record. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, "utf8");
}

export function createTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const path = entry.type === "directory" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
    if (Buffer.byteLength(path) > 100) {
      const record = paxRecord("path", path);
      parts.push(header("PaxHeader", "x", 0o644, record.length, mtime), record, padding(record.length));
    }
    // header() keeps the first 100 bytes; the pax record above carries the full path.
    if (entry.type === "directory") {
      parts.push(header(path, "5", entry.mode, 0, mtime));
    } else {
      const content = Buffer.from(entry.content);
      parts.push(header(path, "0", entry.mode, content.length, mtime), content, padding(content.length));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSnapshotTar, safeSnapshotPath, SnapshotTooLargeError } from "./preview-snapshot";

let root: string;
const longName = `${"nested-folder/".repeat(8)}page.html`;

/** An archive of `dir` written by the system's tar, in the given format. */
const archive = (dir: string, format: string) =>
  new Uint8Array(execFileSync("tar", [`--format=${format}`, "-cf", "-", "-C", dir, "."], { maxBuffer: 64 << 20 }));

/** A one-file archive with a hand-written ustar header, for names tar itself would not write. */
function rawArchive(name: string, content: string, type = "0"): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content);
  return new Uint8Array(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "abotica-snapshot-"));
  const site = path.join(root, "site");
  mkdirSync(path.join(site, "css"), { recursive: true });
  writeFileSync(path.join(site, "index.html"), "<h1>Mockup</h1>");
  writeFileSync(path.join(site, "css", "app.css"), "h1{color:red}");
  mkdirSync(path.join(site, path.dirname(longName)), { recursive: true });
  writeFileSync(path.join(site, longName), "deep");
  symlinkSync("/etc/passwd", path.join(site, "secrets"));
  symlinkSync("..", path.join(site, "up"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readSnapshotTar", () => {
  it.each(["gnutar", "pax", "ustar"])("keeps the regular files of a %s archive and drops links", (format) => {
    const { files, skipped } = readSnapshotTar(archive(path.join(root, "site"), format));
    const byPath = new Map(files.map((f) => [f.path, new TextDecoder().decode(f.data)]));
    expect(byPath.get("index.html")).toBe("<h1>Mockup</h1>");
    expect(byPath.get("css/app.css")).toBe("h1{color:red}");
    if (format !== "ustar") expect(byPath.get(longName)).toBe("deep");
    // Neither the links nor what they point at; macOS tar may add ._ files for extended attributes.
    expect([...byPath.keys()].some((p) => p === "secrets" || p === "up" || p.startsWith("up/"))).toBe(false);
    expect([...byPath.values()].some((text) => text.includes("root:"))).toBe(false);
    expect(skipped.map((s) => s.replace(/^\.\//, "")).sort()).toEqual(expect.arrayContaining(["secrets", "up"]));
  });

  it("refuses paths that would leave the copy", () => {
    for (const name of ["../escape.html", "/etc/passwd", "a/../../b"]) {
      const { files, skipped } = readSnapshotTar(rawArchive(name, "x"));
      expect(files).toEqual([]);
      expect(skipped).toEqual([name]);
    }
  });

  it("skips hard links and devices", () => {
    expect(readSnapshotTar(rawArchive("hard", "", "1")).skipped).toEqual(["hard"]);
    expect(readSnapshotTar(rawArchive("dev", "", "3")).skipped).toEqual(["dev"]);
  });

  it("stops at the size limit", () => {
    const big = path.join(root, "big");
    mkdirSync(big);
    writeFileSync(path.join(big, "blob.bin"), Buffer.alloc(51 * 1024 * 1024));
    expect(() => readSnapshotTar(archive(big, "gnutar"))).toThrow(SnapshotTooLargeError);
  });
});

describe("safeSnapshotPath", () => {
  it("normalizes paths inside and rejects the rest", () => {
    expect(safeSnapshotPath("./a/./b.html")).toBe("a/b.html");
    expect(safeSnapshotPath("a//b")).toBe("a/b");
    expect(safeSnapshotPath("")).toBeNull();
    expect(safeSnapshotPath(".")).toBeNull();
    expect(safeSnapshotPath("a/../b")).toBeNull();
    expect(safeSnapshotPath("a\\b")).toBeNull();
    expect(safeSnapshotPath("/a")).toBeNull();
  });
});

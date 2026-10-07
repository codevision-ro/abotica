import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Bundle } from "../types";
import { assertBundle, BUNDLE_STATE_FILE, bundleTar, parseBundleState, planBundleSync } from "./bundles";

const bundle = (name: string, hash: string, files: Bundle["files"] = [{ path: "SKILL.md", content: name }]): Bundle => ({
  name,
  hash,
  files,
});

describe("planBundleSync", () => {
  it("writes new and changed bundles and keeps the others", () => {
    const plan = planBundleSync({ a: "1", b: "1", c: "1" }, [bundle("a", "1"), bundle("b", "2"), bundle("d", "1")]);
    expect(plan.write.map((b) => b.name)).toEqual(["b", "d"]);
    expect(plan.remove).toEqual(["b"]);
    expect(plan.state).toEqual({ a: "1", b: "2", c: "1", d: "1" });
  });

  it("never removes bundles another run may be using", () => {
    const plan = planBundleSync({ a: "1", c: "1" }, []);
    expect(plan.write).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.state).toEqual({ a: "1", c: "1" });
  });

  it("does nothing when everything matches", () => {
    const plan = planBundleSync({ a: "1" }, [bundle("a", "1")]);
    expect(plan.write).toEqual([]);
    expect(plan.remove).toEqual([]);
  });
});

describe("assertBundle", () => {
  it.each(["../x", "/etc/passwd", "a//b", "a/./b", "", "a/../../b"])("rejects the path %j", (p) => {
    expect(() => assertBundle(bundle("ok", "1", [{ path: p, content: "" }]))).toThrow(/Invalid file path/);
  });

  it.each(["", "Bad", "a/b", ".hidden", "-x", "x".repeat(65)])("rejects the name %j", (name) => {
    expect(() => assertBundle(bundle(name, "1"))).toThrow(/Invalid bundle name/);
  });

  it("accepts nested paths and 64-character names", () => {
    expect(() => assertBundle(bundle("ok", "1", [{ path: "scripts/run.sh", content: "" }]))).not.toThrow();
    expect(() => assertBundle(bundle("x".repeat(64), "1"))).not.toThrow();
  });
});

describe("parseBundleState", () => {
  it("keeps valid entries only", () => {
    expect(parseBundleState('{"a":"1","../x":"2","b":3}')).toEqual({ a: "1" });
    expect(parseBundleState("not json")).toEqual({});
    expect(parseBundleState("[]")).toEqual({});
  });
});

describe("bundleTar", () => {
  it("extracts with the system tar, keeping modes and long paths", () => {
    const longPath = `${"deep/".repeat(30)}file.txt`;
    const plan = planBundleSync({}, [
      bundle("skill-a", "h1", [
        { path: "SKILL.md", content: "# Skill A ✓" },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n", executable: true },
        { path: longPath, content: new Uint8Array([0, 1, 2, 255]) },
      ]),
    ]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "abotica-tar-"));
    try {
      const archive = path.join(dir, "bundle.tar");
      writeFileSync(archive, bundleTar(plan));
      const out = path.join(dir, "out");
      execFileSync("mkdir", [out]);
      execFileSync("tar", ["-x", "-f", archive, "-C", out]);
      expect(readFileSync(path.join(out, "skill-a/SKILL.md"), "utf8")).toBe("# Skill A ✓");
      expect(statSync(path.join(out, "skill-a/scripts/run.sh")).mode & 0o777).toBe(0o755);
      expect(statSync(path.join(out, "skill-a/SKILL.md")).mode & 0o777).toBe(0o644);
      expect([...readFileSync(path.join(out, "skill-a", longPath))]).toEqual([0, 1, 2, 255]);
      expect(JSON.parse(readFileSync(path.join(out, BUNDLE_STATE_FILE), "utf8"))).toEqual({ "skill-a": "h1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

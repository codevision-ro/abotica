import { describe, expect, it, vi } from "vitest";
import { ensurePackages, installScript, packagesHash } from "./packages";
import type { Workspace } from "./types";

describe("packagesHash", () => {
  it("ignores order and duplicates", () => {
    expect(packagesHash({ python: ["b", "a", "a"], node: ["y", "x"] })).toBe(
      packagesHash({ python: ["a", "b"], node: ["x", "y"] }),
    );
  });

  it("tells the ecosystems apart", () => {
    expect(packagesHash({ python: ["a"], node: [] })).not.toBe(packagesHash({ python: [], node: ["a"] }));
  });

  it("changes with a version", () => {
    expect(packagesHash({ python: ["pandas"], node: [] })).not.toBe(packagesHash({ python: ["pandas==2.2.3"], node: [] }));
  });
});

describe("installScript", () => {
  it("quotes every spec", () => {
    const script = installScript({ python: ["uvicorn[standard]>=0.30"], node: ["sharp@0.34"] });
    expect(script).toContain("'uvicorn[standard]>=0.30'");
    expect(script).toContain("npm install --prefix .abotica/node --no-audit --no-fund --no-progress sharp@0.34");
  });

  it("only installs the declared ecosystems", () => {
    const script = installScript({ python: [], node: ["left-pad"] });
    expect(script).not.toContain("venv");
    expect(script).toContain(packagesHash({ python: [], node: ["left-pad"] }));
  });
});

describe("ensurePackages", () => {
  it("runs one install at a time per workspace", async () => {
    let running = 0;
    let most = 0;
    const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    const workspace = (key: string): Workspace => ({
      key,
      paths: { workspace: "/w", bundles: "/b", home: "/w/.home" },
      async exec() {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return {
          stdin: null,
          stdout: empty(),
          stderr: empty(),
          wait: async () => ({ exitCode: 0, timedOut: false }),
          kill: async () => {},
        };
      },
    });
    const packages = { python: ["six"], node: [] };
    await Promise.all([
      ensurePackages(workspace("a"), packages, []),
      ensurePackages(workspace("a"), packages, []),
      ensurePackages(workspace("a"), packages, []),
    ]);
    expect(most).toBe(1);
    await Promise.all([ensurePackages(workspace("b"), packages, []), ensurePackages(workspace("c"), packages, [])]);
    expect(most).toBe(2);
  });

  it("skips without running anything when nothing is declared", async () => {
    const workspace = { key: "x", paths: { workspace: "/w", bundles: "/b", home: "/h" }, exec: vi.fn() };
    expect(await ensurePackages(workspace, { python: [], node: [] }, [])).toEqual({ installed: false, log: "" });
    expect(workspace.exec).not.toHaveBeenCalled();
  });
});

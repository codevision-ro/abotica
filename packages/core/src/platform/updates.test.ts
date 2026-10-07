import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Updates from "./updates";

let compareVersions: typeof Updates.compareVersions;
let currentVersion: typeof Updates.currentVersion;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  ({ compareVersions, currentVersion } = await import("./updates"));
});

describe("compareVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
  });

  it("puts a prerelease before its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0);
  });
});

describe("currentVersion", () => {
  const before = process.env.ABOTICA_VERSION;
  afterEach(() => {
    if (before === undefined) delete process.env.ABOTICA_VERSION;
    else process.env.ABOTICA_VERSION = before;
  });

  it("reads ABOTICA_VERSION without a leading v, and is null from source", () => {
    process.env.ABOTICA_VERSION = "v0.2.0";
    expect(currentVersion()).toBe("0.2.0");
    process.env.ABOTICA_VERSION = " ";
    expect(currentVersion()).toBeNull();
    delete process.env.ABOTICA_VERSION;
    expect(currentVersion()).toBeNull();
  });
});

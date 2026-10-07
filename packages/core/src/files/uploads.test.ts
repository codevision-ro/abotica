import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUpload, uploadsRoot } from "./uploads";

const config = vi.hoisted(() => ({ UPLOADS_DIR: undefined as string | undefined }));
vi.mock("../infra/env", () => ({ env: () => config }));

describe("resolveUpload", () => {
  beforeEach(() => {
    config.UPLOADS_DIR = undefined;
  });

  it.each(["/srv/uploads/", "/srv/uploads", "/srv/./uploads//"])("resolves files under %j", (dir) => {
    config.UPLOADS_DIR = dir;
    expect(uploadsRoot()).toBe("/srv/uploads");
    expect(resolveUpload("a/b.txt")).toBe("/srv/uploads/a/b.txt");
  });

  it("resolves a relative UPLOADS_DIR against the current folder", () => {
    config.UPLOADS_DIR = "data/uploads";
    expect(resolveUpload("a.txt")).toBe(path.resolve("data/uploads", "a.txt"));
  });

  it.each(["../secret", "a/../../secret", "/etc/passwd", "", "."])("refuses %j", (relative) => {
    config.UPLOADS_DIR = "/srv/uploads/";
    expect(resolveUpload(relative)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/tasks", "/tasks"],
    ["/tasks?view=list&q=a%20b", "/tasks?view=list&q=a%20b"],
    ["/runs/1#events", "/runs/1#events"],
    ["/preview/abc?return=%2F%2Fevil.com", "/preview/abc?return=%2F%2Fevil.com"],
    ["/a/../b", "/b"],
    // Encoded characters stay encoded, so the browser never reads them as separators.
    ["/%09/evil.com", "/%09/evil.com"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["/%5Cevil.com", "/%5Cevil.com"],
  ])("keeps %j as %j", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "tasks",
    " /tasks",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "\\/evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\n/evil.com",
    "/\u0000/evil.com",
    "/\u007f/evil.com",
    "/.//evil.com",
    "/..//evil.com",
    "/a/..//evil.com",
    "https://evil.com",
    "http:/evil.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ])("refuses %j", (value) => {
    expect(safeReturnPath(value)).toBe("/");
  });

  it("checks against the given origin", () => {
    expect(safeReturnPath("/tasks?x=1", "https://app.example.com")).toBe("/tasks?x=1");
    expect(safeReturnPath("/.//evil.com", "https://app.example.com")).toBe("/");
    expect(safeReturnPath("/tasks", "not a url")).toBe("/");
  });
});

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell";

describe("shellQuote", () => {
  it.each(["pandas", "sharp@0.34", "a/b.txt", "--flag", "key=value", "@scope/pkg"])("leaves %j bare", (value) => {
    expect(shellQuote(value)).toBe(value);
  });

  it.each(["", "two words", "it's", "$(id)", "`id`", "a;b", "*", "=cmd", "line\nbreak", "uvicorn[standard]>=0.30", "~"])(
    "quotes %j so bash reads it back unchanged",
    (value) => {
      const quoted = shellQuote(value);
      expect(quoted).not.toBe(value);
      expect(execFileSync("bash", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" })).toBe(value);
    },
  );

  it("rejects NUL bytes", () => {
    expect(() => shellQuote("a\0b")).toThrow();
  });
});

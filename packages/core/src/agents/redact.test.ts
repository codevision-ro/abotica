import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redact";

const TOKEN = "ghp_0123456789abcdef";

describe("redactSecrets", () => {
  it("replaces every occurrence in nested results", () => {
    const result = { exitCode: 0, stdout: `A=${TOKEN}\nB=${TOKEN}`, list: [`x${TOKEN}y`, 3], nested: { s: TOKEN } };
    expect(redactSecrets(result, [TOKEN])).toEqual({
      exitCode: 0,
      stdout: `A=${REDACTED}\nB=${REDACTED}`,
      list: [`x${REDACTED}y`, 3],
      nested: { s: REDACTED },
    });
  });

  it("leaves values without secrets, and non-plain objects, as they are", () => {
    const date = new Date(0);
    const result = { stdout: "nothing here", date };
    expect(redactSecrets(result, [TOKEN])).toEqual(result);
    expect(redactSecrets(result, [TOKEN]).date).toBe(date);
  });

  it("ignores values too short to be tokens", () => {
    expect(redactSecrets("main branch", ["main", ""])).toBe("main branch");
  });

  it("returns the value itself when there is nothing to redact", () => {
    const result = { stdout: TOKEN };
    expect(redactSecrets(result, [])).toBe(result);
  });
});

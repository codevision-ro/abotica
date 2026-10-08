import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets, secretRedactor } from "./redact";

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

describe("secretRedactor", () => {
  it("replaces the secrets it knows, including ones added later, the longest first", () => {
    const redactor = secretRedactor([TOKEN]);
    redactor.add(["api-key-value-1", "api-key-value-1-extended"]);
    expect(redactor.redact({ text: `${TOKEN} api-key-value-1-extended api-key-value-1` })).toEqual({
      text: `${REDACTED} ${REDACTED} ${REDACTED}`,
    });
  });

  it("replaces well-known token shapes it was never told about", () => {
    const redactor = secretRedactor();
    const shapes = [
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"B".repeat(30)}`,
      `glpat-${"c".repeat(20)}`,
      `sk-proj-${"d".repeat(40)}`,
      `sk-ant-api03-${"e".repeat(40)}`,
      `sk_live_${"f".repeat(24)}`,
      "AKIAIOSFODNN7EXAMPLE",
      `AIza${"g".repeat(35)}`,
      `xoxb-${"1".repeat(12)}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.${"h".repeat(20)}`,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ];
    for (const shape of shapes) expect(redactor.redact(`value: ${shape}.`), shape).toBe(`value: ${REDACTED}.`);
    expect(redactor.redact(`Authorization: Bearer ${"t".repeat(30)}`)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactor.redact("Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0")).toBe(`Authorization: Basic ${REDACTED}`);
  });

  it("leaves ordinary text alone", () => {
    const text = "task-1234567890abcdefghijk, Basic internationalization, Bearer token, ask-question, sk-short, AKIA-docs";
    expect(secretRedactor(["short"]).redact(text)).toBe(text);
  });
});

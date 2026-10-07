import { isUserError } from "@abotica/i18n";
import { describe, expect, it } from "vitest";
import { redactStoredRecord, resolveStoredRecord, resolveStoredSecret } from "./mcp-stored-values";

describe("redactStoredRecord", () => {
  it("shows values that reference the vault and hides the rest", () => {
    expect(
      redactStoredRecord({
        Authorization: "Bearer {{secret:API_TOKEN}}",
        "X-Key": "sk-live-123",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({ Authorization: "Bearer {{secret:API_TOKEN}}", "X-Key": null, LOG_LEVEL: null });
  });
});

describe("resolveStoredRecord", () => {
  const saved = { TOKEN: "sk-live-123", LOG_LEVEL: "debug" };

  it("keeps hidden values, follows renames and takes typed ones as they are", () => {
    expect(resolveStoredRecord({ API_TOKEN: { keep: "TOKEN" }, LOG_LEVEL: "info", NEW: "{{secret:X}}" }, saved)).toEqual({
      API_TOKEN: "sk-live-123",
      LOG_LEVEL: "info",
      NEW: "{{secret:X}}",
    });
  });

  it("drops entries the form removed", () => {
    expect(resolveStoredRecord({ LOG_LEVEL: { keep: "LOG_LEVEL" } }, saved)).toEqual({ LOG_LEVEL: "debug" });
  });

  it("refuses to keep a value that is not saved", () => {
    const keep = () => resolveStoredRecord({ TOKEN: { keep: "GONE" } }, saved);
    expect(keep).toThrow();
    try {
      keep();
    } catch (error) {
      expect(isUserError(error) && error.key).toBe("mcp.errors.storedValueMissing");
    }
    expect(() => resolveStoredRecord({ TOKEN: { keep: "TOKEN" } }, null)).toThrow();
  });
});

describe("resolveStoredSecret", () => {
  it("keeps, replaces or clears the client secret", () => {
    expect(resolveStoredSecret({ keep: true }, "s3cret")).toBe("s3cret");
    expect(resolveStoredSecret("new", "s3cret")).toBe("new");
    expect(resolveStoredSecret(null, "s3cret")).toBeNull();
    expect(() => resolveStoredSecret({ keep: true }, null)).toThrow();
  });
});

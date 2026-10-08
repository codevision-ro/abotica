import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgres://test@localhost/test";
const { rejectionText } = await import("./approvals");

describe("rejectionText", () => {
  it("tells the model the user said no, so it reports it instead of asking for access", () => {
    expect(rejectionText()).toBe(
      "The user rejected this call when asked for approval. It was not run. Do not retry it or work around it: report it to whoever gave you the task (the user, in a conversation with them).",
    );
  });

  it("carries the user's reason when there is one", () => {
    expect(rejectionText("  not on the live site  ")).toMatch(/approval, saying: not on the live site\. It was not run/);
  });
});

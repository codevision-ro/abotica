import { describe, expect, it } from "vitest";
import { factKey } from "./memory-facts";

describe("factKey", () => {
  it("ignores case, spacing and trailing punctuation", () => {
    expect(factKey("  The client prefers   email.  ")).toBe("the client prefers email");
    expect(factKey("The client prefers email!?")).toBe(factKey("the client prefers email"));
    expect(factKey("Clientul preferă\nemailul;")).toBe("clientul preferă emailul");
  });

  it("keeps punctuation inside the text", () => {
    expect(factKey("Deadline: 2026-10-07.")).toBe("deadline: 2026-10-07");
  });

  it("treats composed and decomposed diacritics alike", () => {
    expect(factKey("Ședință lunară")).toBe(factKey("Ședință lunară"));
  });
});

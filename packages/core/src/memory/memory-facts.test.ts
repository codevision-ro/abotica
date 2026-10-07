import { describe, expect, it } from "vitest";
import { factKey, restatesFact } from "./memory-facts";

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

describe("restatesFact", () => {
  const existing = ["The client prefers email.", "Invoices go out on the 1st"];

  it("finds a fact that only differs in case, spacing or final punctuation", () => {
    expect(restatesFact("the client  prefers email", existing)).toBe(true);
    expect(restatesFact("Invoices go out on the 1st.", existing)).toBe(true);
  });

  it("does not match a different fact or an empty memory", () => {
    expect(restatesFact("The client prefers phone calls", existing)).toBe(false);
    expect(restatesFact("The client prefers email", [])).toBe(false);
  });
});

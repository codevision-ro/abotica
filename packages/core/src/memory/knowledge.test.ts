import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // The schema's client needs a URL; nothing connects.
  process.env.DATABASE_URL ??= "postgres://test@localhost/test";
});

const { knowledgeTsQuery } = await import("./knowledge");

describe("knowledgeTsQuery", () => {
  it("matches any topic word of the query, without its stopwords", () => {
    expect(knowledgeTsQuery("AvocatulOnline ghid de stil v1 articole")).toBe(
      "'avocatulonline' | 'ghid' | 'stil' | 'v1' | 'articole'",
    );
  });

  it("folds Romanian diacritics, both the comma and the cedilla forms", () => {
    expect(knowledgeTsQuery("Șablon așteptare înțelegere ştampilă")).toBe(
      "'sablon' | 'asteptare' | 'intelegere' | 'stampila'",
    );
  });

  it("is null when no word carries a topic", () => {
    expect(knowledgeTsQuery("de la și")).toBeNull();
  });
});

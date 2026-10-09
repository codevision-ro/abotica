import { describe, expect, it } from "vitest";
import {
  type Candidate,
  cosineSimilarity,
  decay,
  fuseScores,
  isStopword,
  keywordScore,
  MAX_QUERY_WORDS,
  mmr,
  orTsQuery,
  rankCandidates,
  textSimilarity,
} from "./memory-ranking";

const now = new Date("2026-10-08T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const candidate = (over: Partial<Candidate> & { text: string }): Candidate => ({
  similarity: null,
  textRank: 0,
  embedding: null,
  at: now,
  evergreen: false,
  ...over,
});

describe("orTsQuery", () => {
  it("matches any of the words, each once", () => {
    expect(orTsQuery("deploy staging server")).toBe("'deploy' | 'staging' | 'server'");
    expect(orTsQuery("Deploy  staging\nDEPLOY")).toBe("'deploy' | 'staging'");
  });

  it("quotes every word, so tsquery operators are plain text", () => {
    expect(orTsQuery("ERR_42 (fatal)! a&b|c:*")).toBe("'err_42' | '(fatal)!' | 'a&b|c:*'");
  });

  it("doubles quotes and backslashes inside a word", () => {
    expect(orTsQuery("o'brien")).toBe("'o''brien'");
    expect(orTsQuery("C:\\path\\x.txt")).toBe("'c:\\\\path\\\\x.txt'");
    expect(orTsQuery("'quoted'")).toBe("'''quoted'''");
  });

  it("drops words without a letter or digit", () => {
    expect(orTsQuery("&|!():*' deploy ---")).toBe("'deploy'");
    expect(orTsQuery("&|!():*'")).toBeNull();
    expect(orTsQuery("   ")).toBeNull();
  });

  it("keeps diacritics, in their composed form", () => {
    expect(orTsQuery("Ședință")).toBe(orTsQuery("Ședință"));
    expect(orTsQuery("ședință")).toBe("'ședință'");
  });

  it("keeps at most MAX_QUERY_WORDS words", () => {
    const words = Array.from({ length: MAX_QUERY_WORDS + 10 }, (_, i) => `w${i}`);
    expect(orTsQuery(words.join(" "))?.split(" | ")).toHaveLength(MAX_QUERY_WORDS);
  });

  it("matches a message by its topic words, not its stopwords", () => {
    expect(orTsQuery("What is the status of the deploy to staging?")).toBe("'status' | 'deploy' | 'staging?'");
    expect(orTsQuery("Care este parola de la serverul de staging și cum mă conectez?")).toBe(
      "'parola' | 'serverul' | 'staging' | 'conectez?'",
    );
  });

  it("is null for a message without a topic word", () => {
    expect(orTsQuery("ok, thanks!")).toBeNull();
    expect(orTsQuery("Da, mersi. Ce mai faci?")).toBe("'faci?'");
    expect(orTsQuery("Can you do it for me?")).toBeNull();
  });

  it("counts MAX_QUERY_WORDS after dropping stopwords", () => {
    const words = Array.from({ length: MAX_QUERY_WORDS }, (_, i) => `the w${i} and`);
    expect(orTsQuery(words.join(" "))?.split(" | ")).toHaveLength(MAX_QUERY_WORDS);
  });
});

describe("isStopword", () => {
  it("drops English and Romanian function words in any case and with punctuation around them", () => {
    for (const word of ["the", "The", "to,", "(and)", "is?", "de", "pentru", "este", "sunt"]) {
      expect(isStopword(word.toLowerCase())).toBe(true);
    }
  });

  it("folds diacritics, both the comma and the cedilla forms", () => {
    for (const word of ["și", "şi", "si", "să", "în", "îți", "până", "după", "ţi"]) expect(isStopword(word)).toBe(true);
  });

  it("drops contractions, with straight or typographic apostrophes", () => {
    expect(isStopword("it's")).toBe(true);
    expect(isStopword("don\u2019t")).toBe(true);
  });

  it("drops single letters and hyphenated words made only of stopwords", () => {
    for (const word of ["x", "s-a", "într-o", "nu-i", "dintr-un"]) expect(isStopword(word)).toBe(true);
  });

  it("keeps topic words, including ones that look like short function words", () => {
    for (const word of ["deploy", "parola", "e-mail", "ai", "cat", "v2", "5", "staging", "ședință"]) {
      expect(isStopword(word)).toBe(false);
    }
  });
});

describe("keywordScore", () => {
  it("maps a rank to 0..1, one match to 0.5", () => {
    expect(keywordScore(0)).toBe(0);
    expect(keywordScore(1)).toBe(0.5);
    expect(keywordScore(3)).toBe(0.75);
    expect(keywordScore(1000)).toBeLessThan(1);
  });
});

describe("fuseScores", () => {
  it("weighs the vector score 0.7 and the keyword score 0.3", () => {
    expect(fuseScores({ vector: 1, keyword: 0 })).toBeCloseTo(0.7);
    expect(fuseScores({ vector: 0, keyword: 1 })).toBeCloseTo(0.3);
    expect(fuseScores({ vector: 0.5, keyword: 0.5 })).toBeCloseTo(0.5);
  });

  it("uses the keyword score alone without a query vector", () => {
    expect(fuseScores({ vector: null, keyword: 0.6 })).toBe(0.6);
  });
});

describe("decay", () => {
  it("halves the score every 30 days", () => {
    expect(decay(1, 0)).toBe(1);
    expect(decay(1, 30)).toBeCloseTo(0.5);
    expect(decay(0.8, 60)).toBeCloseTo(0.2);
  });

  it("does not raise the score of a date in the future", () => {
    expect(decay(1, -5)).toBe(1);
  });

  it("takes another half-life", () => {
    expect(decay(1, 7, 7)).toBeCloseTo(0.5);
  });
});

describe("cosineSimilarity and textSimilarity", () => {
  it("measures embeddings", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("measures shared words", () => {
    expect(textSimilarity("Deploy to staging", "deploy to STAGING!")).toBe(1);
    expect(textSimilarity("deploy staging", "deploy production")).toBeCloseTo(1 / 3);
    expect(textSimilarity("", "deploy")).toBe(0);
  });
});

describe("mmr", () => {
  type Item = { id: string; score: number; embedding: number[] };
  const similarity = (a: Item, b: Item) => cosineSimilarity(a.embedding, b.embedding);
  const items: Item[] = [
    { id: "deploy", score: 1, embedding: [1, 0, 0] },
    { id: "deploy-again", score: 0.95, embedding: [0.99, 0.01, 0] },
    { id: "staging", score: 0.8, embedding: [0, 1, 0] },
    { id: "weak", score: 0.2, embedding: [0, 0, 1] },
  ];

  it("with lambda 0.7, pushes a near duplicate below a distinct relevant entry", () => {
    expect(mmr(items, { similarity }).map((i) => i.id)).toEqual(["deploy", "staging", "deploy-again", "weak"]);
  });

  it("keeps the score order with lambda 1 and stops at the limit", () => {
    expect(mmr(items, { similarity, lambda: 1, limit: 2 }).map((i) => i.id)).toEqual(["deploy", "deploy-again"]);
  });

  it("handles no items and a single item", () => {
    expect(mmr([], { similarity })).toEqual([]);
    expect(mmr([items[0]!], { similarity })).toEqual([items[0]]);
  });
});

describe("rankCandidates", () => {
  it("ranks an exact keyword match above entries that are only a little closer by vector", () => {
    const ranked = rankCandidates(
      [
        candidate({ text: "Deploys go to Hetzner", similarity: 0.6, embedding: [1, 0, 0] }),
        candidate({ text: "Staging runs nightly", similarity: 0.58, embedding: [0, 1, 0] }),
        candidate({ text: "ERR_42 means the token expired", similarity: 0.5, textRank: 1, embedding: [0, 0, 1] }),
      ],
      { hybrid: true, limit: 3, now },
    );
    expect(ranked[0]?.text).toBe("ERR_42 means the token expired");
  });

  it("counts vector scores from the model's unrelated level, so a model with high similarities keeps keywords in play", () => {
    // EmbeddingGemma puts entries that do not answer near 0.18: 0.3 is barely related, a keyword match beats it.
    const entries = [
      candidate({ text: "Close by vector only", similarity: 0.3, embedding: [1, 0] }),
      candidate({ text: "Shares the query's word", similarity: 0.25, textRank: 1, embedding: [0, 1] }),
    ];
    const raw = rankCandidates(entries, { hybrid: true, limit: 2, now });
    const counted = rankCandidates(entries, { hybrid: true, limit: 2, now, unrelatedSimilarity: 0.18 });
    expect(raw[0]?.score).toBeCloseTo(0.7 * 0.25 + 0.3 * 0.5);
    expect(counted[0]?.text).toBe("Shares the query's word");
    expect(counted[1]?.score).toBeCloseTo(0.7 * ((0.3 - 0.18) / 0.82));
  });

  it("gives an entry without an embedding its keyword share in hybrid mode", () => {
    const [ranked] = rankCandidates([candidate({ text: "no embedding", textRank: 1 })], {
      hybrid: true,
      limit: 1,
      now,
    });
    expect(ranked?.score).toBeCloseTo(0.15);
  });

  it("ranks by keyword alone without a query vector", () => {
    const ranked = rankCandidates(
      [candidate({ text: "one word", textRank: 1 }), candidate({ text: "three words", textRank: 3 })],
      { hybrid: false, limit: 2, now },
    );
    expect(ranked.map((c) => c.text)).toEqual(["three words", "one word"]);
    expect(ranked[0]?.score).toBeCloseTo(0.75);
  });

  it("decays by age, except pinned and permanent entries", () => {
    const ranked = rankCandidates(
      [
        candidate({ text: "old", similarity: 1, at: daysAgo(30) }),
        candidate({ text: "old pinned", similarity: 1, at: daysAgo(90), evergreen: true }),
      ],
      { hybrid: true, limit: 2, now },
    );
    expect(ranked.map((c) => [c.text, Number(c.score.toFixed(3))])).toEqual([
      ["old pinned", 0.7],
      ["old", 0.35],
    ]);
  });

  it("prefers the newer of two equally relevant entries", () => {
    const ranked = rankCandidates(
      [
        candidate({ text: "release on 2026-10-20", similarity: 0.8, at: daysAgo(40) }),
        candidate({ text: "release moved to 2026-11-02", similarity: 0.8, at: daysAgo(1) }),
      ],
      { hybrid: true, limit: 2, now },
    );
    expect(ranked[0]?.text).toBe("release moved to 2026-11-02");
  });

  it("returns at most the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate({ text: `entry ${i}`, textRank: i + 1 }));
    expect(rankCandidates(many, { hybrid: false, limit: 4, now })).toHaveLength(4);
  });
});

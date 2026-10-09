import { describe, expect, it } from "vitest";
import {
  EMBEDDING_PROFILES,
  embeddingFingerprint,
  embeddingInput,
  LEGACY_EMBEDDING_FINGERPRINTS,
  vectorRelevance,
} from "./embedding-profiles";

describe("embeddingInput", () => {
  it("puts the model's retrieval prompt before a query and before a stored text", () => {
    expect(embeddingInput("local", "query", "Unde e găzduită aplicația?")).toBe(
      "task: search result | query: Unde e găzduită aplicația?",
    );
    expect(embeddingInput("ollama", "document", "Deploy pe Hetzner.")).toBe("title: none | text: Deploy pe Hetzner.");
  });
});

describe("embeddingFingerprint", () => {
  it("names the provider, the model and the revision of its prompts", () => {
    expect(embeddingFingerprint("ollama")).toBe("ollama/embeddinggemma#1");
  });

  it("tells the models of older releases from today's", () => {
    expect(LEGACY_EMBEDDING_FINGERPRINTS.local).not.toBe(embeddingFingerprint("local"));
    expect(LEGACY_EMBEDDING_FINGERPRINTS.ollama).not.toBe(embeddingFingerprint("ollama"));
  });
});

describe("vectorRelevance", () => {
  it("counts from the model's unrelated level, so an unrelated entry scores 0", () => {
    expect(vectorRelevance(0.18, 0.18)).toBe(0);
    expect(vectorRelevance(0.1, 0.18)).toBe(0);
    expect(vectorRelevance(1, 0.18)).toBe(1);
    expect(vectorRelevance(0.59, 0.18)).toBeCloseTo(0.5);
  });

  it("is the similarity itself for a model without a level", () => {
    expect(vectorRelevance(0.42, 0)).toBeCloseTo(0.42);
    expect(vectorRelevance(-0.1, 0)).toBe(0);
  });
});

describe("EMBEDDING_PROFILES", () => {
  it("keeps every threshold where it can work: related under 1, recall above the unrelated level", () => {
    for (const profile of Object.values(EMBEDDING_PROFILES)) {
      expect(profile.relatedDistance).toBeGreaterThan(0);
      expect(profile.relatedDistance).toBeLessThan(1);
      expect(profile.recallSimilarity).toBeGreaterThanOrEqual(profile.unrelatedSimilarity);
    }
  });

  it("shares the thresholds of the built-in model and Ollama, which run the same weights", () => {
    expect({ ...EMBEDDING_PROFILES.local, model: "" }).toEqual({ ...EMBEDDING_PROFILES.ollama, model: "" });
  });
});

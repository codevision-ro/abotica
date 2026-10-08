import { describe, expect, it } from "vitest";
import { blendedPrice, consumptionLevel, consumptionOf, MIN_RATED_RUNS, modelClass, rateModel } from "./model-ratings";

/** A price whose blend is exactly `blended`. */
const flat = (blended: number) => ({ input: blended, output: blended });

describe("blendedPrice", () => {
  it("weighs input three times as much as output", () => {
    expect(blendedPrice({ input: 3, output: 15 })).toBe(6);
    expect(blendedPrice({ input: 0, output: 0 })).toBe(0);
  });
});

describe("consumptionLevel", () => {
  it("maps the blended price to 1 to 5, each bound starting the next level", () => {
    expect(consumptionLevel(flat(0))).toBe(1);
    expect(consumptionLevel(flat(0.49))).toBe(1);
    expect(consumptionLevel(flat(0.5))).toBe(2);
    expect(consumptionLevel(flat(1.49))).toBe(2);
    expect(consumptionLevel(flat(1.5))).toBe(3);
    expect(consumptionLevel(flat(6.99))).toBe(3);
    expect(consumptionLevel(flat(7))).toBe(4);
    expect(consumptionLevel(flat(14.99))).toBe(4);
    expect(consumptionLevel(flat(15))).toBe(5);
    expect(consumptionLevel(flat(100))).toBe(5);
  });

  it("uses the blend, not the input price alone", () => {
    // Input $1 alone would be level 2; with output at $5 the blend is $2.
    expect(consumptionLevel({ input: 1, output: 5 })).toBe(3);
  });

  it("has no level without a price", () => {
    expect(consumptionLevel(null)).toBeNull();
    expect(consumptionOf(null)).toBeNull();
  });
});

describe("modelClass", () => {
  it("groups 1-2 as fast, 3 as balanced, 4-5 as powerful", () => {
    expect([1, 2, 3, 4, 5].map((l) => modelClass(l as 1 | 2 | 3 | 4 | 5))).toEqual([
      "fast",
      "fast",
      "balanced",
      "powerful",
      "powerful",
    ]);
    expect(consumptionOf(flat(10))).toEqual({ level: 4, class: "powerful" });
  });
});

describe("rateModel", () => {
  const runs = (succeeded: number, failed: number, tokens = 0) => ({ succeeded, failed, tokens });

  it("recommends by class when there is no data yet", () => {
    expect(rateModel(flat(0.2)).recommendedFor).toEqual(["orchestrator"]);
    expect(rateModel(flat(3)).recommendedFor).toEqual(["manager", "agent"]);
    expect(rateModel(flat(20)).recommendedFor).toEqual(["demanding"]);
    expect(rateModel(flat(3))).toMatchObject({ runs: 0, successRate: null, avgTokens: null, withdrawn: null });
  });

  it("recommends nothing for a model without a price", () => {
    expect(rateModel(null, runs(20, 0))).toMatchObject({ consumption: null, recommendedFor: [], withdrawn: null });
  });

  it("measures the success rate only from the minimum number of runs", () => {
    expect(rateModel(flat(3), runs(MIN_RATED_RUNS - 1, 0)).successRate).toBeNull();
    expect(rateModel(flat(3), runs(MIN_RATED_RUNS - 2, 2)).successRate).toBe(0.8);
  });

  it("keeps the recommendation at exactly 80%", () => {
    expect(rateModel(flat(3), runs(8, 2))).toMatchObject({ recommendedFor: ["manager", "agent"], withdrawn: null });
  });

  it("withdraws the recommendation below 80% with enough data", () => {
    expect(rateModel(flat(3), runs(7, 3))).toMatchObject({
      successRate: 0.7,
      recommendedFor: [],
      withdrawn: "lowSuccessRate",
    });
  });

  it("does not withdraw on a low rate from too few runs", () => {
    expect(rateModel(flat(3), runs(1, 5))).toMatchObject({ recommendedFor: ["manager", "agent"], withdrawn: null });
  });

  it("averages the tokens over the counted runs", () => {
    expect(rateModel(flat(3), runs(3, 1, 10_002)).avgTokens).toBe(2501);
    expect(rateModel(null, runs(2, 0, 3000))).toMatchObject({ runs: 2, avgTokens: 1500 });
  });
});

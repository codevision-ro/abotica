import { describe, expect, it, vi } from "vitest";
import {
  allowedModelChain,
  allowsModelChain,
  ANY_PROVIDER,
  combinePolicies,
  deniesEveryModel,
  providerAllowed,
  providerPolicyOf,
} from "./provider-policy";

// Only the loaders touch the database; the rules tested here are pure.
vi.mock("@abotica/db", () => ({ db: {}, messages: {}, projects: {}, tasks: {} }));

const only = (...allowed: string[]) => ({ allowed });
const chain = [
  { provider: "anthropic", model: "claude" },
  { provider: "ollama", model: "llama" },
  { provider: "openai", model: "gpt" },
];

describe("providerPolicyOf", () => {
  it("treats a project without allowed providers, or no project, as unrestricted", () => {
    expect(providerPolicyOf({ allowedProviders: [] })).toEqual(ANY_PROVIDER);
    expect(providerPolicyOf(null)).toEqual(ANY_PROVIDER);
    expect(providerPolicyOf({ allowedProviders: ["ollama"] })).toEqual(only("ollama"));
  });
});

describe("combinePolicies", () => {
  it("keeps only the providers every policy allows", () => {
    expect(combinePolicies(only("ollama", "openai"), only("openai", "anthropic"))).toEqual(only("openai"));
    expect(combinePolicies(ANY_PROVIDER, only("ollama"), ANY_PROVIDER)).toEqual(only("ollama"));
    expect(combinePolicies(ANY_PROVIDER, ANY_PROVIDER)).toEqual(ANY_PROVIDER);
    expect(combinePolicies()).toEqual(ANY_PROVIDER);
  });

  it("allows nothing, rather than anything, when the restrictions do not overlap", () => {
    const none = combinePolicies(only("ollama"), only("openai"));
    expect(none).toEqual(only());
    expect(providerAllowed(none, "ollama")).toBe(false);
    expect(providerAllowed(none, "openai")).toBe(false);
  });
});

describe("providerAllowed", () => {
  it("allows any provider without a restriction and only the listed ones with one", () => {
    expect(providerAllowed(ANY_PROVIDER, "openai")).toBe(true);
    expect(providerAllowed(only("ollama"), "ollama")).toBe(true);
    expect(providerAllowed(only("ollama"), "openai")).toBe(false);
  });
});

describe("allowedModelChain", () => {
  it("keeps the allowed models in their order", () => {
    expect(allowedModelChain(only("openai", "ollama"), chain).map((m) => m.model)).toEqual(["llama", "gpt"]);
    expect(allowedModelChain(ANY_PROVIDER, chain)).toEqual(chain);
    expect(allowedModelChain(only("deepseek"), chain)).toEqual([]);
  });
});

describe("allowsModelChain", () => {
  it("is true only when every model of the chain is allowed", () => {
    expect(allowsModelChain(ANY_PROVIDER, chain)).toBe(true);
    expect(allowsModelChain(only("anthropic", "ollama", "openai"), chain)).toBe(true);
    expect(allowsModelChain(only("ollama"), chain)).toBe(false);
  });
});

describe("deniesEveryModel", () => {
  it("is true when the chain has models and none is allowed", () => {
    expect(deniesEveryModel(only("deepseek"), chain)).toBe(true);
    expect(deniesEveryModel(combinePolicies(only("ollama"), only("openai")), chain)).toBe(true);
  });

  it("is false when a model is left, or when there was no model to begin with", () => {
    expect(deniesEveryModel(only("ollama"), chain)).toBe(false);
    expect(deniesEveryModel(only("deepseek"), [])).toBe(false);
  });
});

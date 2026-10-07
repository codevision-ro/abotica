import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  effortOptions,
  inheritedEffort,
  type ModelsDevReasoningOption,
  REASONING_EFFORTS,
  type ReasoningSupport,
  resolveEffort,
  supportFromModelsDev,
  supportFromOllama,
} from "./reasoning";
import { mergeProviderOptions, ORIGIN_KEY, ownReasoningOnly, reasoningRequest } from "./reasoning-request";

// Shapes taken from models.dev and Ollama's /api/show.
const deepseek: ReasoningSupport = { efforts: ["low", "high", "max"], canDisable: true };
const alwaysOn: ReasoningSupport = { efforts: [], canDisable: false };

describe("supportFromModelsDev", () => {
  it("keeps known effort levels in order and ignores unknown values", () => {
    expect(supportFromModelsDev(true, [{ type: "effort", values: ["high", "default", "none", "low", ""] }])).toEqual({
      efforts: ["low", "high"],
      canDisable: true,
    });
  });

  it("reads a toggle as a way to turn reasoning off", () => {
    expect(supportFromModelsDev(true, [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }])).toEqual(
      deepseek,
    );
  });

  it("gives budget-only models the levels the AI SDK turns into a budget", () => {
    expect(supportFromModelsDev(true, [{ type: "budget_tokens", min: 1024 }])).toEqual({
      efforts: ["low", "medium", "high"],
      canDisable: false,
    });
  });

  it("prefers named levels over a budget", () => {
    const options: ModelsDevReasoningOption[] = [
      { type: "effort", values: ["low", "medium", "high"] },
      { type: "budget_tokens", min: 1024 },
    ];
    expect(supportFromModelsDev(true, options)?.efforts).toEqual(["low", "medium", "high"]);
  });

  it("treats reasoning without options as always on", () => {
    expect(supportFromModelsDev(true, [])).toEqual(alwaysOn);
  });

  it("returns null for models without reasoning", () => {
    expect(supportFromModelsDev(false, [{ type: "toggle" }])).toBeNull();
    expect(supportFromModelsDev(undefined, undefined)).toBeNull();
  });
});

describe("supportFromOllama", () => {
  it("reads named levels and an off switch", () => {
    expect(supportFromOllama({ thinking: { values: [false, "low", "medium", "high"] } })).toEqual({
      efforts: ["low", "medium", "high"],
      canDisable: true,
    });
  });

  it("reads on/off-only models", () => {
    expect(supportFromOllama({ thinking: { values: [true, false] } })).toEqual({ efforts: [], canDisable: true });
  });

  it("returns null when thinking is only ever off", () => {
    expect(supportFromOllama({ capabilities: ["thinking"], thinking: { values: [false] } })).toBeNull();
  });

  it("falls back to the capability list without thinking metadata", () => {
    expect(supportFromOllama({ capabilities: ["completion", "thinking"] })).toEqual({ efforts: [], canDisable: true });
    expect(supportFromOllama({ capabilities: ["completion"] })).toBeNull();
  });
});

describe("inheritedEffort", () => {
  it("takes the most specific source that sets an effort", () => {
    expect(inheritedEffort("low", "high", "max")).toBe("low");
    expect(inheritedEffort(null, "high", "max")).toBe("high");
    expect(inheritedEffort(undefined, "default", "max")).toBe("max");
  });

  it("lets the model decide when no source sets one", () => {
    expect(inheritedEffort(null, "default", "default")).toBe("default");
    expect(inheritedEffort()).toBe("default");
  });

  it("treats none as a choice, not as unset", () => {
    expect(inheritedEffort(null, "none", "high")).toBe("none");
  });
});

describe("effortOptions", () => {
  it("offers default, off when possible, then the model's levels", () => {
    expect(effortOptions(deepseek)).toEqual(["default", "none", "low", "high", "max"]);
    expect(effortOptions(alwaysOn)).toEqual(["default"]);
  });

  it("offers only default for models without reasoning and everything for unknown ones", () => {
    expect(effortOptions(null)).toEqual(["default"]);
    expect(effortOptions(undefined)).toEqual([...REASONING_EFFORTS]);
  });
});

describe("resolveEffort", () => {
  it("keeps supported efforts and default", () => {
    expect(resolveEffort("high", deepseek)).toBe("high");
    expect(resolveEffort("none", deepseek)).toBe("none");
    expect(resolveEffort("default", deepseek)).toBe("default");
  });

  it("moves to the nearest level, the higher one on a tie", () => {
    expect(resolveEffort("medium", deepseek)).toBe("high");
    expect(resolveEffort("xhigh", deepseek)).toBe("max");
    expect(resolveEffort("minimal", deepseek)).toBe("low");
    expect(resolveEffort("max", { efforts: ["low", "medium", "high"], canDisable: false })).toBe("high");
  });

  it("uses the lowest level when reasoning cannot be turned off", () => {
    expect(resolveEffort("none", { efforts: ["low", "high"], canDisable: false })).toBe("low");
    expect(resolveEffort("none", alwaysOn)).toBe("default");
  });

  it("sends nothing to models without reasoning or without levels", () => {
    expect(resolveEffort("high", null)).toBe("default");
    expect(resolveEffort("high", alwaysOn)).toBe("default");
  });

  it("passes the request through for models the catalog does not know", () => {
    expect(resolveEffort("max", undefined)).toBe("max");
  });
});

describe("reasoningRequest", () => {
  it("keeps OpenAI stateless on every call", () => {
    expect(reasoningRequest("openai", "gpt-5.5", "default")).toEqual({ providerOptions: { openai: { store: false } } });
    expect(reasoningRequest("openai", "gpt-5.5", "high")).toEqual({
      reasoning: "high",
      providerOptions: { openai: { store: false } },
    });
    expect(reasoningRequest("openai", "gpt-6-sol", "max")).toEqual({
      providerOptions: { openai: { reasoningEffort: "max", store: false } },
    });
  });

  it("writes out adaptive thinking for Anthropic and binds it only on always-thinking models", () => {
    expect(reasoningRequest("anthropic", "claude-opus-4-7", "max")).toEqual({
      providerOptions: { anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" } },
    });
    expect(reasoningRequest("anthropic", "claude-opus-5-5", "high")).toEqual({
      providerOptions: {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized", blockBinding: { prefixMismatchBehavior: "drop_block" } },
          effort: "high",
        },
      },
    });
    expect(reasoningRequest("anthropic", "claude-opus-5-5", "default")).toEqual({
      providerOptions: {
        anthropic: { thinking: { type: "adaptive", blockBinding: { prefixMismatchBehavior: "drop_block" } } },
      },
    });
    expect(reasoningRequest("anthropic", "claude-opus-4-7", "default")).toEqual({});
  });

  it("leaves Anthropic's off switch and budget-only models to the AI SDK", () => {
    expect(reasoningRequest("anthropic", "claude-sonnet-5-5", "none")).toEqual({ reasoning: "none" });
    expect(reasoningRequest("anthropic", "claude-haiku-4-5", "medium")).toEqual({ reasoning: "medium" });
  });

  it("maps xhigh to max on Anthropic models without xhigh", () => {
    expect(reasoningRequest("anthropic", "claude-sonnet-4-6", "xhigh").providerOptions?.anthropic?.effort).toBe("max");
  });

  it("sends max natively where the AI SDK cannot", () => {
    expect(reasoningRequest("deepseek", "deepseek-v4-pro", "max")).toEqual({
      providerOptions: { deepseek: { reasoningEffort: "max" } },
    });
    expect(reasoningRequest("deepseek", "deepseek-v4-pro", "low")).toEqual({ reasoning: "low" });
    expect(reasoningRequest("ollama", "gpt-oss", "max")).toEqual({
      providerOptions: { ollama: { reasoningEffort: "max" } },
    });
  });

  it("uses Kimi's own thinking switch", () => {
    expect(reasoningRequest("moonshot", "kimi-k2.6", "none")).toEqual({
      providerOptions: { moonshot: { thinking: { type: "disabled" } } },
    });
    expect(reasoningRequest("moonshot", "kimi-k3", "max")).toEqual({
      providerOptions: { moonshot: { reasoningEffort: "max" } },
    });
    expect(reasoningRequest("moonshot", "kimi-k3", "default")).toEqual({});
  });

  it("falls back to the AI SDK option for providers without their own mapping", () => {
    expect(reasoningRequest("future", "model", "max")).toEqual({ reasoning: "xhigh" });
    expect(reasoningRequest("future", "model", "default")).toEqual({});
  });
});

describe("mergeProviderOptions", () => {
  it("merges each provider's options, later sources winning", () => {
    expect(mergeProviderOptions({ openai: { store: true, user: "u" } }, undefined, { openai: { store: false } })).toEqual({
      openai: { store: false, user: "u" },
    });
    expect(mergeProviderOptions(undefined, {})).toBeUndefined();
  });
});

describe("ownReasoningOnly", () => {
  const reasoning = (providerOptions?: Record<string, Record<string, string>>) =>
    ({ type: "reasoning", text: "thinking", providerOptions }) as const;
  const prompt: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        reasoning({ [ORIGIN_KEY]: { provider: "deepseek" } }),
        reasoning({ [ORIGIN_KEY]: { provider: "openai" }, openai: { itemId: "rs_1" } }),
        reasoning({ anthropic: { signature: "sig" } }),
        reasoning(),
        { type: "text", text: "hello" },
      ],
    },
  ];
  // Each kept part as its provider ("?" when unattributed) or, for other parts, its type.
  const kept = (provider: string) => {
    const message = ownReasoningOnly(prompt, provider)[1]!;
    if (message.role !== "assistant") throw new Error("expected the assistant message");
    return message.content.map((p) =>
      p.type === "reasoning"
        ? String(p.providerOptions?.[ORIGIN_KEY]?.provider ?? Object.keys(p.providerOptions ?? {})[0] ?? "?")
        : p.type,
    );
  };

  it("keeps the target provider's reasoning, unattributed reasoning and everything else", () => {
    expect(kept("deepseek")).toEqual(["deepseek", "?", "text"]);
    expect(kept("openai")).toEqual(["openai", "?", "text"]);
  });

  it("attributes parts saved before stamping by their provider metadata", () => {
    expect(kept("anthropic")).toEqual(["anthropic", "?", "text"]);
  });

  it("returns untouched messages as they are", () => {
    expect(ownReasoningOnly(prompt, "openai")[0]).toBe(prompt[0]);
  });
});

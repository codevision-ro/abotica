import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./context";

/** model-chain.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./model-chain");
}

afterEach(() => vi.unstubAllEnvs());

const AGENTS = [{ provider: "deepseek", model: "chat" }];
const MANAGERS = [
  { provider: "openai", model: "gpt" },
  { provider: "deepseek", model: "chat" },
];
const settings = {
  defaultModels: AGENTS,
  orchestratorModels: [],
  managerModels: MANAGERS,
} as unknown as RunContext["settings"];
const agent = { provider: null, model: null, fallbacks: [], isOrchestrator: false } as unknown as RunContext["agent"];

describe("fullModelChain", () => {
  it("runs a manager on default on the managers' chain", async () => {
    const { fullModelChain } = await load();
    expect(fullModelChain({ agent, settings, conversation: null, isManager: true })).toEqual(MANAGERS);
    expect(fullModelChain({ agent, settings, conversation: null, isManager: false })).toEqual(AGENTS);
  });

  it("puts the conversation's override before the role's chain, once", async () => {
    const { fullModelChain } = await load();
    const conversation = { modelOverride: { provider: "deepseek", model: "chat" } } as RunContext["conversation"];
    expect(fullModelChain({ agent, settings, conversation, isManager: true })).toEqual([
      { provider: "deepseek", model: "chat" },
      { provider: "openai", model: "gpt" },
    ]);
  });
});

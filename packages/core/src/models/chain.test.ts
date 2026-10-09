import { afterEach, describe, expect, it, vi } from "vitest";

/** chain.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./chain");
}

afterEach(() => vi.unstubAllEnvs());

const AGENTS = [{ provider: "deepseek", model: "chat" }];
const MANAGERS = [{ provider: "openai", model: "gpt" }];
const settings = { chains: { agent: AGENTS, orchestrator: [], manager: MANAGERS } };
const onDefault = { provider: null, model: null, fallbacks: [] };

describe("resolveModelChain", () => {
  it("runs an agent on default on its role's chain, or the agents' one when that is empty", async () => {
    const { resolveModelChain } = await load();
    expect(resolveModelChain(onDefault, settings, "manager")).toEqual(MANAGERS);
    expect(resolveModelChain(onDefault, settings, "agent")).toEqual(AGENTS);
    expect(resolveModelChain(onDefault, settings, "orchestrator")).toEqual(AGENTS);
  });

  it("keeps an agent's own model and fallbacks whatever its role", async () => {
    const { resolveModelChain } = await load();
    const own = { provider: "anthropic", model: "opus", fallbacks: [{ provider: "ollama", model: "llama" }] };
    const chain = [{ provider: "anthropic", model: "opus" }, ...own.fallbacks];
    expect(resolveModelChain(own, settings, "manager")).toEqual(chain);
    expect(resolveModelChain(own, settings, "agent")).toEqual(chain);
  });

  it("treats a provider without a model as the default", async () => {
    const { resolveModelChain } = await load();
    expect(resolveModelChain({ provider: "anthropic", model: null, fallbacks: [] }, settings, "manager")).toEqual(MANAGERS);
  });
});

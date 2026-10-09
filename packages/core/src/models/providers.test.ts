import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings/settings-schema";

/** providers.ts imports the database client, which needs a URL; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  return import("./providers");
}

afterEach(() => vi.unstubAllEnvs());

const unset = DEFAULT_SETTINGS.models.baseUrls;

describe("providerBaseUrl", () => {
  it("leaves the SDK's own address when Settings has none", async () => {
    const { providerBaseUrl } = await load();
    expect(providerBaseUrl(unset, "anthropic")).toBeUndefined();
    expect(providerBaseUrl(unset, "openai")).toBeUndefined();
    expect(providerBaseUrl(unset, "deepseek")).toBeUndefined();
  });

  it("gives Moonshot its public API, since its generic client has no address of its own", async () => {
    const { providerBaseUrl } = await load();
    expect(providerBaseUrl(unset, "moonshot")).toBe("https://api.moonshot.ai/v1");
  });

  it("uses the address set for that provider only", async () => {
    const { providerBaseUrl } = await load();
    const baseUrls = { ...unset, openai: "https://gateway.example.com/openai/v1", moonshot: "https://api.moonshot.cn/v1" };
    expect(providerBaseUrl(baseUrls, "openai")).toBe("https://gateway.example.com/openai/v1");
    expect(providerBaseUrl(baseUrls, "moonshot")).toBe("https://api.moonshot.cn/v1");
    expect(providerBaseUrl(baseUrls, "anthropic")).toBeUndefined();
  });
});

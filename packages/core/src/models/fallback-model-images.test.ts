import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackModel } from "./fallback-model";
import { languageModel } from "./providers";

// The chain's models come from the test; the real loaders read keys and settings from the database.
vi.mock("./providers", async () => {
  const { UserError } = await import("@abotica/i18n");
  class ProviderNotConfiguredError extends UserError {
    constructor(readonly provider: string) {
      super("errors.providerNotConfigured");
    }
  }
  return { languageModel: vi.fn(), ProviderNotConfiguredError };
});
// A model that sees images, so the tool images reach it and it can refuse them.
vi.mock("./catalog", () => ({
  getCatalog: async () => [{ provider: "anthropic", id: "vision", input: ["text", "image"] }],
}));

const VISION = { provider: "anthropic", model: "vision" };

const generated: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "ok" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

const badRequest = (message: string) =>
  new APICallError({ message, url: "https://api.example.test/v1", requestBodyValues: {}, statusCode: 400 });

const imageResult = (id: string, data: string) => ({
  type: "tool-result" as const,
  toolCallId: id,
  toolName: "file_read",
  output: {
    type: "content" as const,
    value: [
      { type: "file" as const, mediaType: "image/png", filename: `${id}.png`, data: { type: "data" as const, data } },
    ],
  },
});

const prompt = (...results: ReturnType<typeof imageResult>[]): LanguageModelV4Prompt => [
  { role: "user", content: [{ type: "text", text: "Check the page." }] },
  ...results.map((result) => ({ role: "tool" as const, content: [result] })),
];

/** The data of each image still in a call's prompt, oldest first. */
const imagesIn = (options: LanguageModelV4CallOptions) =>
  options.prompt.flatMap((message) =>
    message.role !== "tool"
      ? []
      : message.content.flatMap((part) =>
          part.type === "tool-result" && part.output.type === "content"
            ? part.output.value.flatMap((item) =>
                item.type === "file" && item.data.type === "data" ? [String(item.data.data)] : [],
              )
            : [],
        ),
  );

/** A model that refuses any call whose prompt still holds one of `refused`. */
function refusing(refused: string[], message = "Could not process image") {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      if (imagesIn(options).some((data) => refused.includes(data))) throw badRequest(message);
      return generated;
    },
  });
}

const use = (model: MockLanguageModelV4) => vi.mocked(languageModel).mockResolvedValue(model);

const GOOD = "G".repeat(300);
const BAD = "B".repeat(300);
const WORSE = "W".repeat(300);

afterEach(() => {
  vi.mocked(languageModel).mockReset();
});

describe("FallbackModel with images a provider refuses", () => {
  it("calls again without the newest tool image, and leaves it out of later calls", async () => {
    const model = refusing([BAD]);
    use(model);
    const fallback = new FallbackModel([VISION]);

    const result = await fallback.doGenerate({ prompt: prompt(imageResult("a", GOOD), imageResult("b", BAD)) });
    expect(result.content).toEqual(generated.content);
    expect(model.doGenerateCalls.map(imagesIn)).toEqual([[GOOD, BAD], [GOOD]]);
    const replaced = model.doGenerateCalls[1]!.prompt[2];
    expect(replaced?.role === "tool" && replaced.content[0]).toMatchObject({
      output: {
        type: "content",
        value: [{ type: "text", text: expect.stringContaining('File "b.png" could not be read') }],
      },
    });

    // The next step sends every tool result again: the refused image stays out from the start.
    await fallback.doGenerate({ prompt: prompt(imageResult("a", GOOD), imageResult("b", BAD), imageResult("c", GOOD)) });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(imagesIn(model.doGenerateCalls[2]!)).toEqual([GOOD, GOOD]);
  });

  it("then leaves out every tool image when the newest was not the one", async () => {
    const model = refusing([BAD]);
    use(model);
    const fallback = new FallbackModel([VISION]);

    await fallback.doGenerate({ prompt: prompt(imageResult("a", BAD), imageResult("b", GOOD)) });
    expect(model.doGenerateCalls.map(imagesIn)).toEqual([[BAD, GOOD], [BAD], []]);
  });

  it("gives up after that, with the provider's error", async () => {
    // With no image left, the model still refuses: the prompt has another problem.
    const stubborn = new MockLanguageModelV4({
      doGenerate: async () => {
        throw badRequest("Could not process image");
      },
    });
    use(stubborn);
    const fallback = new FallbackModel([VISION]);
    await expect(fallback.doGenerate({ prompt: prompt(imageResult("a", BAD), imageResult("b", WORSE)) })).rejects.toThrow(
      "Could not process image",
    );
    expect(stubborn.doGenerateCalls.map(imagesIn)).toEqual([[BAD, WORSE], [BAD], []]);
  });

  it("does not retry without images when there are none, or on other errors", async () => {
    const noImages = new MockLanguageModelV4({
      doGenerate: async () => {
        throw badRequest("Could not process image");
      },
    });
    use(noImages);
    await expect(new FallbackModel([VISION]).doGenerate({ prompt: prompt() })).rejects.toThrow();
    expect(noImages.doGenerateCalls).toHaveLength(1);

    const other = new MockLanguageModelV4({
      doGenerate: async () => {
        throw badRequest("messages: text content blocks must be non-empty");
      },
    });
    use(other);
    await expect(new FallbackModel([VISION]).doGenerate({ prompt: prompt(imageResult("a", BAD)) })).rejects.toThrow(
      "non-empty",
    );
    expect(other.doGenerateCalls).toHaveLength(1);
  });
});

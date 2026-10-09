import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  acceptedFilesOnly,
  acceptsFile,
  fileModality,
  inputFromOllama,
  isImageRejection,
  toolImageKey,
  toolImageKeys,
  withoutRejectedImages,
} from "./input-modalities";

describe("fileModality", () => {
  it("maps media types to models.dev input modalities", () => {
    expect(fileModality("image/png")).toBe("image");
    expect(fileModality("application/pdf")).toBe("pdf");
    expect(fileModality("Audio/MPEG; rate=44100")).toBe("audio");
    expect(fileModality("video/mp4")).toBe("video");
  });

  it("returns null for files no model reads directly", () => {
    expect(fileModality("text/plain")).toBeNull();
    expect(fileModality("application/zip")).toBeNull();
  });
});

describe("acceptsFile", () => {
  it("follows the model's input modalities", () => {
    expect(acceptsFile(["text", "image", "pdf"], "application/pdf")).toBe(true);
    expect(acceptsFile(["text", "image"], "image/jpeg")).toBe(true);
    expect(acceptsFile(["text", "image"], "application/pdf")).toBe(false);
    expect(acceptsFile(["text"], "image/png")).toBe(false);
  });

  it("keeps files from models with unknown modalities", () => {
    expect(acceptsFile(null, "image/png")).toBe(false);
    expect(acceptsFile(undefined, "application/pdf")).toBe(false);
  });

  it("never accepts types without a modality", () => {
    expect(acceptsFile(["text", "image", "pdf"], "text/plain")).toBe(false);
  });
});

describe("inputFromOllama", () => {
  it("adds images for vision models", () => {
    expect(inputFromOllama({ capabilities: ["completion", "vision", "tools"] })).toEqual(["text", "image"]);
    expect(inputFromOllama({ capabilities: ["completion", "tools"] })).toEqual(["text"]);
    expect(inputFromOllama({})).toEqual(["text"]);
  });
});

describe("acceptedFilesOnly", () => {
  const pdf = {
    type: "file" as const,
    mediaType: "application/pdf",
    filename: "report.pdf",
    data: { type: "data" as const, data: "JVBERi0=" },
  };
  const image = { type: "file" as const, mediaType: "image/png", data: { type: "data" as const, data: "iVBORw==" } };
  const prompt: LanguageModelV4Prompt = [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "[Attached file]" }, pdf, image] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];

  it("replaces the files the model cannot read with a line saying so", () => {
    const [, user] = acceptedFilesOnly(prompt, ["text", "image"]);
    expect(user).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Attached file]" },
        { type: "text", text: '[File "report.pdf" is not shown: this model cannot read application/pdf files directly.]' },
        image,
      ],
    });
  });

  it("drops every file for a model with unknown modalities", () => {
    const [, user] = acceptedFilesOnly(prompt, null);
    expect(user?.role === "user" && user.content.map((p) => p.type)).toEqual(["text", "text", "text"]);
  });

  it("leaves the prompt alone when the model reads every file", () => {
    const result = acceptedFilesOnly(prompt, ["text", "image", "pdf"]);
    expect(result[1]).toBe(prompt[1]);
    expect(result[2]).toBe(prompt[2]);
  });
});

describe("acceptedFilesOnly in tool results", () => {
  const screenshot = {
    type: "file" as const,
    mediaType: "image/png",
    filename: "shot.png",
    data: { type: "data" as const, data: "iVBORw0KGgo=" },
  };
  const prompt: LanguageModelV4Prompt = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "file_read",
          output: { type: "content", value: [{ type: "text", text: "shot.png: image/png." }, screenshot] },
        },
        {
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "file_write",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
  ];

  it("replaces an image a tool returned when the model cannot see images", () => {
    const [tool] = acceptedFilesOnly(prompt, ["text"]);
    expect(tool?.role === "tool" && tool.content[0]).toMatchObject({
      output: {
        type: "content",
        value: [
          { type: "text", text: "shot.png: image/png." },
          { type: "text", text: '[File "shot.png" is not shown: this model cannot read image/png files directly.]' },
        ],
      },
    });
    expect(tool?.role === "tool" && tool.content[1]).toBe(prompt[0]!.content[1]);
  });

  it("keeps the message as it is for a model that sees images", () => {
    expect(acceptedFilesOnly(prompt, ["text", "image"])[0]).toBe(prompt[0]);
  });
});

describe("rejected tool images", () => {
  const image = (data: string, filename?: string) => ({
    type: "file" as const,
    mediaType: "image/png",
    ...(filename && { filename }),
    data: { type: "data" as const, data },
  });
  const result = (id: string, ...files: ReturnType<typeof image>[]) => ({
    type: "tool-result" as const,
    toolCallId: id,
    toolName: "file_read",
    output: { type: "content" as const, value: files },
  });
  const broken = image("A".repeat(200) + "broken", "bad.png");
  const fine = image("B".repeat(200), "good.png");
  const prompt: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "Look." }] },
    { role: "tool", content: [result("call-1", fine)] },
    { role: "tool", content: [result("call-2", broken)] },
  ];

  it("keys images by type, length and both ends of their data", () => {
    expect(toolImageKey(fine)).toBe(`image/png:200:${"B".repeat(64)}:${"B".repeat(64)}`);
    expect(toolImageKey(broken)).not.toBe(toolImageKey(image("A".repeat(200) + "brokeN")));
    expect(toolImageKey({ ...fine, mediaType: "application/pdf" })).toBeNull();
    expect(toolImageKeys(prompt)).toEqual([toolImageKey(fine), toolImageKey(broken)]);
  });

  it("replaces only the rejected images", () => {
    const next = withoutRejectedImages(prompt, new Set([toolImageKey(broken)!]));
    expect(next[0]).toBe(prompt[0]);
    expect(next[1]).toBe(prompt[1]);
    expect(next[2]).toEqual({
      role: "tool",
      content: [
        {
          ...result("call-2"),
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: '[File "bad.png" could not be read by the model: the image may be corrupt, cut short or in a form it does not take. Check or create it again.]',
              },
            ],
          },
        },
      ],
    });
    expect(withoutRejectedImages(prompt, new Set())).toBe(prompt);
  });

  it("recognizes providers refusing an image", () => {
    for (const message of [
      "messages.3.content.0.image.source.base64.data: Could not process image",
      "Invalid image.",
      "The image data you provided does not represent a valid image.",
      "The provided image is corrupt or unsupported",
      "Unable to process input image. Please retry.",
      "unable to decode image data",
    ]) {
      expect(isImageRejection(message), message).toBe(true);
    }
    for (const message of ["Rate limit reached", "Invalid API key", "image_url is required", "Context length exceeded"]) {
      expect(isImageRejection(message), message).toBe(false);
    }
  });
});

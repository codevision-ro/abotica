import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { acceptedFilesOnly, acceptsFile, fileModality, inputFromOllama } from "./input-modalities";

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

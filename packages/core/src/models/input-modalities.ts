/**
 * Which files a model reads directly. The catalog lists each model's input modalities (models.dev
 * `modalities.input`, Ollama's capabilities); the fallback chain uses them to take out, per model,
 * the file parts it cannot read, which some providers would otherwise drop without a word.
 * Pure and client-safe.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

/** The input modality a file needs ("image", "pdf", "audio", "video"), or null when no model reads it as a file. */
export function fileModality(mediaType: string): string | null {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  const topLevel = type.split("/")[0];
  return topLevel === "image" || topLevel === "audio" || topLevel === "video" ? topLevel : null;
}

/**
 * Whether a model with these input modalities reads the file directly. Unknown modalities (null, or
 * a model the catalog does not list) read none: a file part is only sent where the catalog says so.
 */
export function acceptsFile(input: readonly string[] | null | undefined, mediaType: string): boolean {
  const modality = fileModality(mediaType);
  return modality !== null && (input?.includes(modality) ?? false);
}

/** Input modalities from Ollama's /api/show: text, plus images for a model with "vision". */
export function inputFromOllama(show: { capabilities?: string[] }): string[] {
  return show.capabilities?.includes("vision") ? ["text", "image"] : ["text"];
}

const fileLabel = (filename: string | undefined) => (filename ? `File ${JSON.stringify(filename)}` : "This file");

/**
 * The prompt with each user file part the model cannot read replaced by a line saying so. The note
 * the runner put before it (name, path, size) stays, so the model knows the file is there.
 */
export function acceptedFilesOnly(
  prompt: LanguageModelV4Prompt,
  input: readonly string[] | null | undefined,
): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role !== "user" || message.content.every((p) => p.type !== "file" || acceptsFile(input, p.mediaType))) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part.type !== "file" || acceptsFile(input, part.mediaType)
          ? part
          : {
              type: "text" as const,
              text: `[${fileLabel(part.filename)} is not shown: this model cannot read ${part.mediaType} files directly.]`,
            },
      ),
    };
  });
}

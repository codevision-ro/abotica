/**
 * Which files a model reads directly. The catalog lists each model's input modalities (models.dev
 * `modalities.input`, Ollama's capabilities); the fallback chain uses them to take out, per model,
 * the file parts it cannot read, which some providers would otherwise drop without a word.
 * Pure and client-safe.
 */
import type { LanguageModelV4Message, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";

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

const notShown = (part: { filename?: string; mediaType: string }) =>
  `[${fileLabel(part.filename)} is not shown: this model cannot read ${part.mediaType} files directly.]`;

type ToolMessage = Extract<LanguageModelV4Message, { role: "tool" }>;
type ToolResultOutput = LanguageModelV4ToolResultOutput;
type ContentOutput = Extract<ToolResultOutput, { type: "content" }>;
type ToolContentPart = ContentOutput["value"][number];
type ToolFilePart = Extract<ToolContentPart, { type: "file" }>;

/**
 * A tool message with each file part of its "content" results passed through `replace` (a text part
 * in its place, or the part unchanged). The message itself comes back when nothing changed, so a
 * prompt without such files keeps its identity.
 */
function mapToolFiles(message: ToolMessage, replace: (part: ToolFilePart) => ToolContentPart): ToolMessage {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "tool-result" || part.output.type !== "content") return part;
    const value = part.output.value.map((item) => {
      if (item.type !== "file") return item;
      const next = replace(item);
      if (next !== item) changed = true;
      return next;
    });
    return { ...part, output: { ...part.output, value } };
  });
  return changed ? { ...message, content } : message;
}

/**
 * The prompt with each file part the model cannot read replaced by a line saying so: the files of
 * user messages, whose note from the runner (name, path, size) stays so the model knows the file is
 * there, and the files of tool results (an image file_read or a browser screenshot returned).
 */
export function acceptedFilesOnly(
  prompt: LanguageModelV4Prompt,
  input: readonly string[] | null | undefined,
): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role === "tool") {
      return mapToolFiles(message, (part) =>
        acceptsFile(input, part.mediaType) ? part : { type: "text", text: notShown(part) },
      );
    }
    if (message.role !== "user" || message.content.every((p) => p.type !== "file" || acceptsFile(input, p.mediaType))) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part.type !== "file" || acceptsFile(input, part.mediaType) ? part : { type: "text" as const, text: notShown(part) },
      ),
    };
  });
}

/** The base64 (or URL) of a file part as a string; bytes become a short fingerprint of their own. */
function dataText(part: ToolFilePart): string | null {
  const { data } = part;
  if (data.type === "url") return String(data.url);
  if (data.type !== "data") return null;
  if (typeof data.data === "string") return data.data;
  const bytes = data.data;
  const ends = [...bytes.subarray(0, 48), ...bytes.subarray(Math.max(48, bytes.length - 48))];
  return `${bytes.length}:${ends.join(",")}`;
}

/**
 * Identifies an image a tool returned, from its type, length and both ends of its data, so the same
 * image is found again in the next step's prompt (which the AI SDK rebuilds from the tool results)
 * without holding on to megabytes of base64. Null for parts that are not images with data.
 */
export function toolImageKey(part: ToolFilePart): string | null {
  if (fileModality(part.mediaType) !== "image") return null;
  const data = dataText(part);
  return data === null ? null : `${part.mediaType}:${data.length}:${data.slice(0, 64)}:${data.slice(-64)}`;
}

/** The keys of the images in the prompt's tool results, oldest first. */
export function toolImageKeys(prompt: LanguageModelV4Prompt): string[] {
  const keys: string[] = [];
  for (const message of prompt) {
    if (message.role !== "tool") continue;
    mapToolFiles(message, (part) => {
      const key = toolImageKey(part);
      if (key !== null) keys.push(key);
      return part;
    });
  }
  return keys;
}

/** The prompt with the tool images whose keys are in `rejected` replaced by a line saying the model could not read them. */
export function withoutRejectedImages(prompt: LanguageModelV4Prompt, rejected: ReadonlySet<string>): LanguageModelV4Prompt {
  if (!rejected.size) return prompt;
  return prompt.map((message) => {
    if (message.role !== "tool") return message;
    return mapToolFiles(message, (part) => {
      const key = toolImageKey(part);
      if (key === null || !rejected.has(key)) return part;
      return {
        type: "text",
        text: `[${fileLabel(part.filename)} could not be read by the model: the image may be corrupt, cut short or in a form it does not take. Check or create it again.]`,
      };
    });
  });
}

/**
 * Errors with which providers refuse an image they cannot decode (e.g. Anthropic's "Could not
 * process image", OpenAI's "does not represent a valid image"), as opposed to any other bad request.
 */
const IMAGE_REJECTION = [
  /could not process (the )?image/i,
  /invalid image/i,
  /does not represent a valid image/i,
  /\bimage\b[^.]{0,80}\b(invalid|corrupt(ed)?|unsupported|not supported|malformed)\b/i,
  /unable to (process|decode)[^.]{0,40}\bimage\b/i,
];

export const isImageRejection = (message: string): boolean => IMAGE_REJECTION.some((re) => re.test(message));

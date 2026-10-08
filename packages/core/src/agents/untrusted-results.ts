/**
 * Tool results that reach the model as untrusted data (see untrusted.ts): a fetched page (web_fetch),
 * knowledge saved from a URL (knowledge_search) and whatever an MCP server returns. Their tools wrap
 * them in toModelOutput; this module covers the results no toModelOutput wraps: a replayed result whose
 * tool is not in the run (its server could not list its tools, it is now denied, a built-in was removed),
 * which the AI SDK sends as it was stored, and a stored MCP error. It also tells whether messages carry
 * untrusted data, for compaction. Server only: the wrappers' ids need the instance's secret.
 */
import type { ModelMessage, ToolResultPart, ToolSet } from "ai";
import { hasUntrusted, type UntrustedSource, wrapUntrusted } from "./untrusted";
import { markerId } from "./untrusted-id";

type ToolOutput = ToolResultPart["output"];

/** MCP tools run as `<server>__<tool>` (see mcp-runtime.ts); no built-in has a double underscore. */
const MCP_SEPARATOR = "__";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Where a result's data came from, when it is untrusted; null for Abotica's own (and for the results
 * those tools wrap nothing in: a web_fetch error, knowledge without a saved page).
 */
function untrustedSource({ toolName, output }: Pick<ToolResultPart, "toolName" | "output">): UntrustedSource | null {
  const value = output.type === "json" ? output.value : undefined;
  if (toolName === "web_fetch") return isObject(value) && "content" in value ? "web" : null;
  if (toolName === "knowledge_search") {
    return Array.isArray(value) && value.some((item) => isObject(item) && item.sourceUrl) ? "knowledge" : null;
  }
  const mcp = toolName.indexOf(MCP_SEPARATOR);
  return mcp > 0 ? `mcp:${toolName.slice(0, mcp)}` : null;
}

/** The output as one wrapped text; an error stays an error. */
function wrapOutput(output: ToolOutput, wrap: (text: string) => string): ToolOutput {
  switch (output.type) {
    case "text":
      return { type: "text", value: wrap(output.value) };
    case "json":
      return { type: "text", value: wrap(JSON.stringify(output.value)) };
    case "error-text":
      return { type: "error-text", value: wrap(output.value) };
    case "error-json":
      return { type: "error-text", value: wrap(JSON.stringify(output.value)) };
    default:
      // Content parts come only from a tool's own toModelOutput; a denial carries no data.
      return output;
  }
}

/**
 * The model messages of a history with every untrusted tool result wrapped: the ones whose tool is not
 * in `tools` (all of them for an empty set) and the errors, which the AI SDK never passes to
 * toModelOutput. Ids come from the tool call ids, so a replay gives the same bytes. `onUntrusted` is
 * called when a result was wrapped here.
 */
export function wrapUntrustedResults(messages: ModelMessage[], tools: ToolSet, onUntrusted: () => void): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        if (Object.hasOwn(tools, part.toolName) && part.output.type !== "error-text") return part;
        const source = untrustedSource(part);
        if (!source) return part;
        onUntrusted();
        const id = markerId(part.toolCallId);
        return { ...part, output: wrapOutput(part.output, (text) => wrapUntrusted(text, { source, id })) };
      }),
    };
  });
}

/** A text result that holds a wrapped block (wrapped here, or by its tool). */
const wrappedText = (output: ToolOutput) =>
  (output.type === "text" || output.type === "error-text") && hasUntrusted(output.value);

/** Whether these model messages hold untrusted data: a wrapped block in a text, or an untrusted tool result. */
export function modelMessagesHaveUntrusted(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") return hasUntrusted(message.content);
    return message.content.some((part) => {
      if (part.type === "text") return hasUntrusted(part.text);
      return part.type === "tool-result" && (untrustedSource(part) !== null || wrappedText(part.output));
    });
  });
}

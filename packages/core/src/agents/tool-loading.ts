/**
 * Deferred tool loading. MCP tools and rarely used built-ins stay out of the request until the agent
 * finds them with `tool_search`: every tool definition costs input tokens on every step, and a long
 * tool list makes the model choose worse. The prompt lists the deferred names, so the agent knows
 * what it can load. Pure: no database or runtime imports.
 */
import { type Tool, toolSearch, type ToolSet, type UIMessage } from "ai";
import { TOOL_CATALOG } from "./tools/tool-catalog";

export const TOOL_SEARCH = "tool_search";

/** Matches returned per search; enough to load a browser workflow (navigate, click, fill, read) at once. */
const TOOL_SEARCH_MAX_RESULTS = 8;

type ToolEntry = { name: string; description?: string };

const DEFERRED_BUILTINS = new Set(TOOL_CATALOG.filter((t) => t.deferred).map((t) => t.name));

/** A built-in tool the catalog marks as rarely used. */
export const isDeferredBuiltin = (name: string) => DEFERRED_BUILTINS.has(name);

const tokenize = (text: string): string[] =>
  text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Tool names in ranked order: names written exactly in the query first (the prompt lists them, so
 * the agent can ask for the ones it needs), then keyword matches, a name word counting twice.
 */
export function rankTools(query: string, tools: ToolEntry[]): string[] {
  const words = query.split(/[\s,]+/).filter(Boolean);
  const exact = words.filter((w) => tools.some((t) => t.name === w));
  // Exact names are not keywords too: "scrapling__get" must not also load every other scrapling tool.
  const terms = [...new Set(words.filter((w) => !exact.includes(w)).flatMap(tokenize))];
  const scored = tools
    .map((t) => {
      const nameTerms = tokenize(t.name);
      const descriptionTerms = tokenize(t.description ?? "");
      const score = terms.reduce(
        (sum, term) => sum + (nameTerms.includes(term) ? 2 : 0) + (descriptionTerms.includes(term) ? 1 : 0),
        0,
      );
      return { name: t.name, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.name);
  return [...new Set([...exact, ...scored])];
}

/** The search tool the agent loads deferred tools with; the AI SDK binds it to the run's tools. */
function toolSearchTool(): Tool {
  return {
    ...toolSearch({ search: ({ query, tools }) => rankTools(query, tools), maxResults: TOOL_SEARCH_MAX_RESULTS }),
    description: `Load tools listed under "More tools" in your instructions. Pass their exact names separated by spaces (e.g. "scrapling__get scrapling__fetch"), or keywords for what you need. Returns up to ${TOOL_SEARCH_MAX_RESULTS} tools; they become callable on your next step. Load everything a task needs in one search.`,
  };
}

/**
 * Tools this conversation already called or loaded: they stay loaded in its later runs, so the agent
 * can call again what it sees in its history.
 */
export function toolsUsedIn(messages: UIMessage[]): Set<string> {
  const used = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const name = part.type === "dynamic-tool" ? part.toolName : part.type.startsWith("tool-") ? part.type.slice(5) : null;
      if (!name) continue;
      used.add(name);
      if (name !== TOOL_SEARCH || !("output" in part)) continue;
      const found = (part.output as { tools?: ToolEntry[] } | undefined)?.tools;
      if (Array.isArray(found)) for (const t of found) if (typeof t?.name === "string") used.add(t.name);
    }
  }
  return used;
}

/**
 * The run's tools with the deferred ones marked, plus `tool_search` when any is left deferred.
 * Returns the names that stay deferred, in tool order, for the prompt.
 */
export function deferTools(
  tools: ToolSet,
  isDeferred: (name: string) => boolean,
  loaded: Set<string>,
): { tools: ToolSet; deferred: string[] } {
  const out: ToolSet = {};
  const deferred: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    if (isDeferred(name) && !loaded.has(name)) {
      out[name] = { ...t, deferLoading: true } as Tool;
      deferred.push(name);
    } else out[name] = t;
  }
  if (deferred.length) out[TOOL_SEARCH] = toolSearchTool();
  return { tools: out, deferred };
}

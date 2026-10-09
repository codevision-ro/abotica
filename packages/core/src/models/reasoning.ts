/**
 * Reasoning effort: what each model supports and how a requested effort resolves for it.
 * Pure and client-safe: no database or server imports. Provider request shapes live in
 * reasoning-request.ts.
 */
import type { ReasoningEffort } from "@abotica/db";

export type { ReasoningEffort };

/** Effort levels from least to most thinking; the order drives the nearest-level match. */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** "default" leaves the choice to the model; "none" turns reasoning off. Display order. */
export const REASONING_EFFORTS = ["default", "none", ...EFFORT_LEVELS] as const satisfies readonly ReasoningEffort[];

/** What a reasoning model accepts. A model without reasoning has `null` instead. */
export type ReasoningSupport = {
  /** Effort levels the model accepts, lowest first; empty when its reasoning cannot be tuned. */
  efforts: EffortLevel[];
  /** Whether reasoning can be turned off ("none"). */
  canDisable: boolean;
};

const isEffortLevel = (value: unknown): value is EffortLevel => EFFORT_LEVELS.includes(value as EffortLevel);

const sortLevels = (levels: Iterable<EffortLevel>): EffortLevel[] => {
  const given = new Set(levels);
  return EFFORT_LEVELS.filter((level) => given.has(level));
};

/** Budget-only models (thinking set in tokens) get the levels the AI SDK turns into a budget. */
const BUDGET_EFFORTS: EffortLevel[] = ["low", "medium", "high"];

/** One entry of models.dev `reasoning_options`. */
export type ModelsDevReasoningOption =
  { type: "effort"; values: string[] } | { type: "toggle" } | { type: "budget_tokens"; min?: number; max?: number };

/** Support from a models.dev entry; values it does not know (e.g. "default") are ignored. */
export function supportFromModelsDev(
  reasoning: boolean | undefined,
  options: ModelsDevReasoningOption[] | undefined,
): ReasoningSupport | null {
  if (!reasoning) return null;
  const effort = options?.find((o) => o.type === "effort");
  const values = effort?.type === "effort" ? effort.values : [];
  const budget = options?.some((o) => o.type === "budget_tokens") ?? false;
  return {
    efforts: values.length ? sortLevels(values.filter(isEffortLevel)) : budget ? BUDGET_EFFORTS : [],
    canDisable: values.includes("none") || (options?.some((o) => o.type === "toggle") ?? false),
  };
}

/** Support from a plain list of effort names; names outside the known levels are ignored. */
export function supportFromEfforts(values: string[]): ReasoningSupport {
  return { efforts: sortLevels(values.filter(isEffortLevel)), canDisable: values.includes("none") };
}

/**
 * Support from Ollama's /api/show: `thinking.values` lists booleans (on/off) and named levels;
 * `[false]` alone means no thinking. Without that metadata the "thinking" capability decides.
 */
export function supportFromOllama(show: {
  capabilities?: string[];
  thinking?: { values?: unknown[] };
}): ReasoningSupport | null {
  const values = show.thinking?.values;
  if (!values) return show.capabilities?.includes("thinking") ? { efforts: [], canDisable: true } : null;
  if (!values.some((v) => v !== false)) return null;
  return { efforts: sortLevels(values.filter(isEffortLevel)), canDisable: values.includes(false) };
}

/**
 * The effort in force: the first source that sets one, from the most specific (conversation) to the
 * least (settings). "default" and null defer to the next source; when none sets one, the model decides.
 */
export function inheritedEffort(...sources: (ReasoningEffort | null | undefined)[]): ReasoningEffort {
  return sources.find((effort) => effort != null && effort !== "default") ?? "default";
}

/** The efforts to offer for a model, in display order; every effort when the model is unknown. */
export function effortOptions(support: ReasoningSupport | null | undefined): ReasoningEffort[] {
  if (support === undefined) return [...REASONING_EFFORTS];
  if (!support) return ["default"];
  return ["default", ...(support.canDisable ? (["none"] as const) : []), ...support.efforts];
}

/**
 * The effort actually sent to a model: the requested one when supported, otherwise the nearest
 * supported level (a tie goes to the higher one, so a fallback model does not think less).
 * "none" on a model that cannot turn reasoning off becomes its lowest level. `undefined` support
 * means the model is not in the catalog: the request passes through and the provider decides.
 */
export function resolveEffort(requested: ReasoningEffort, support: ReasoningSupport | null | undefined): ReasoningEffort {
  if (support === undefined || requested === "default") return requested;
  if (!support) return "default";
  if (requested === "none") return support.canDisable ? "none" : (support.efforts[0] ?? "default");
  if (!support.efforts.length) return "default";
  const rank = EFFORT_LEVELS.indexOf(requested);
  let best = support.efforts[0]!;
  for (const level of support.efforts) {
    if (Math.abs(EFFORT_LEVELS.indexOf(level) - rank) <= Math.abs(EFFORT_LEVELS.indexOf(best) - rank)) best = level;
  }
  return best;
}

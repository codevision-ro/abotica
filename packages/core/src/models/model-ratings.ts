/**
 * The rating of a model, pure: how much it consumes (from its list price), how well it did on our own
 * runs, and which roles it suits. No database: model-stats.ts reads the runs, the settings page shows
 * the result and the model pickers the consumption.
 */
import type { ModelRole } from "./model-role";

/** USD per 1M tokens. */
export type ModelPrice = { input: number; output: number };

/** 1 consumes the least, 5 the most. */
export type ConsumptionLevel = 1 | 2 | 3 | 4 | 5;

export type ModelClass = "fast" | "balanced" | "powerful";

/** Where a model fits: the default chain of a role, or work that needs the strongest models. */
export type ModelUse = ModelRole | "demanding";

export type ModelConsumption = { level: ConsumptionLevel; class: ModelClass };

/** Input tokens per output token in the blended price: agent runs send far more than they write. */
const INPUT_WEIGHT = 3;

/**
 * Upper bounds (exclusive) of the blended price per 1M tokens for levels 1 to 4; anything higher is 5.
 * Small models land on 1 and 2; a $3 / $15 model blends to $6, level 3; frontier prices go to 4 and 5.
 */
export const CONSUMPTION_BOUNDS = [0.5, 1.5, 7, 15] as const;

/** Runs a model needs in the window before its success rate means something. */
export const MIN_RATED_RUNS = 10;

/** Below this success rate a model fails too often to recommend, whatever it costs. */
export const MIN_SUCCESS_RATE = 0.8;

/** Days of runs the performance is measured over. */
export const RATING_WINDOW_DAYS = 30;

/**
 * Failure kinds that come from the model's own work. The others (rate and usage limits, auth, budgets,
 * the kill switch, cancellations, worker restarts) say nothing about the model, so they are not counted.
 */
export const MODEL_FAILURE_KINDS = ["step_limit", "loop", "timeout", "other"] as const;

/** One price per token with input and output weighted the way agent runs use them. */
export function blendedPrice(price: ModelPrice): number {
  return (INPUT_WEIGHT * price.input + price.output) / (INPUT_WEIGHT + 1);
}

/** The consumption level of a price; null without a price (a local model, or one models.dev does not price). */
export function consumptionLevel(price: ModelPrice | null): ConsumptionLevel | null {
  if (!price) return null;
  const blended = blendedPrice(price);
  const index = CONSUMPTION_BOUNDS.findIndex((bound) => blended < bound);
  return (index === -1 ? 5 : index + 1) as ConsumptionLevel;
}

export function modelClass(level: ConsumptionLevel): ModelClass {
  if (level <= 2) return "fast";
  return level === 3 ? "balanced" : "powerful";
}

export function consumptionOf(price: ModelPrice | null): ModelConsumption | null {
  const level = consumptionLevel(price);
  return level ? { level, class: modelClass(level) } : null;
}

/**
 * The uses each class suits. The super agent mostly routes and delegates, so a fast model is enough;
 * managers and agents do the work. A powerful model has no default role: it would spend a plan's limit
 * or the budget on routine runs.
 */
const CLASS_USES: Record<ModelClass, ModelUse[]> = {
  fast: ["orchestrator"],
  balanced: ["manager", "agent"],
  powerful: ["demanding"],
};

/** A model's runs that finished in the window (see model-stats.ts). */
export type ModelRunStats = {
  succeeded: number;
  /** Failed with one of MODEL_FAILURE_KINDS. */
  failed: number;
  /** Input plus output tokens of the succeeded and counted failed runs. */
  tokens: number;
};

export type ModelRating = {
  consumption: ModelConsumption | null;
  /** Counted runs: succeeded plus failed by the model. */
  runs: number;
  /** Share of counted runs that succeeded; null below MIN_RATED_RUNS. */
  successRate: number | null;
  /** Average input plus output tokens of a counted run; null without one. */
  avgTokens: number | null;
  /** Empty when the model has no class, or when its success rate withdrew the recommendation. */
  recommendedFor: ModelUse[];
  /** Why the class's uses are not recommended. */
  withdrawn: "lowSuccessRate" | null;
};

const NO_RUNS: ModelRunStats = { succeeded: 0, failed: 0, tokens: 0 };

export function rateModel(price: ModelPrice | null, stats: ModelRunStats = NO_RUNS): ModelRating {
  const consumption = consumptionOf(price);
  const runs = stats.succeeded + stats.failed;
  const successRate = runs >= MIN_RATED_RUNS ? stats.succeeded / runs : null;
  const uses = consumption ? CLASS_USES[consumption.class] : [];
  const withdrawn = uses.length > 0 && successRate !== null && successRate < MIN_SUCCESS_RATE;
  return {
    consumption,
    runs,
    successRate,
    avgTokens: runs > 0 ? Math.round(stats.tokens / runs) : null,
    recommendedFor: withdrawn ? [] : uses,
    withdrawn: withdrawn ? "lowSuccessRate" : null,
  };
}

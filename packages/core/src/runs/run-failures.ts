import type { runs } from "@abotica/db";
import { NoModelError } from "../models/chain";
import { AllProvidersFailedError } from "../models/fallback-model";
import { ContextOverflowError, type ProviderErrorKind } from "../models/provider-errors";
import { NoAllowedProviderError } from "../models/provider-policy";

/**
 * Why a run ended failed or cancelled (`runs.failure_kind`). `runs.error` keeps the translated text for
 * the user; the kind is what the platform acts on: the task's circuit breaker, the hint in the UI.
 */
export type RunFailureKind = NonNullable<(typeof runs.$inferSelect)["failureKind"]>;

/**
 * The reason a run is aborted with, carrying its kind: whoever aborts a run (a user's cancel, the kill
 * switch, a worker shutting down) says why, and the runner records it as the run's failure kind.
 */
export class RunAbort extends Error {
  constructor(
    message: string,
    readonly kind: RunFailureKind,
  ) {
    super(message);
  }
}

/** The kind an abort reason carries; a plain reason (an error, a string) is `other`. */
export function abortKind(reason: unknown): RunFailureKind {
  return reason instanceof RunAbort ? reason.kind : "other";
}

/** Every model of the chain failed: the kind all of them share, else the chain was unavailable. */
function chainFailureKind(kinds: ProviderErrorKind[]): RunFailureKind {
  if (kinds.every((k) => k === "rate_limited")) return "rate_limited";
  if (kinds.every((k) => k === "rate_limited" || k === "usage_limit")) return "usage_limit";
  if (kinds.every((k) => k === "auth")) return "provider_auth";
  return "providers_unavailable";
}

/**
 * The kind of an error that ended a run. Model errors come from the fallback chain, which already
 * classified each model's failure; anything else (a tool's or the platform's) is `other`.
 */
export function failureKindOf(error: unknown): RunFailureKind {
  if (error instanceof AllProvidersFailedError) return chainFailureKind(error.failures.map((f) => f.kind));
  if (error instanceof ContextOverflowError) return "context_overflow";
  if (error instanceof NoModelError) return "no_model";
  if (error instanceof NoAllowedProviderError) return "provider_not_allowed";
  return "other";
}

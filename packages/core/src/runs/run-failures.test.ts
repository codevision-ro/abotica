import { runFailureKind } from "@abotica/db/schema";
import { locales, messages } from "@abotica/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderErrorKind } from "../models/provider-errors";

/** run-failures.ts reaches the database client through the model errors it knows; nothing connects. */
async function load() {
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  const [failures, fallback, errors, chain, policy] = await Promise.all([
    import("./run-failures"),
    import("../models/fallback-model"),
    import("../models/provider-errors"),
    import("../models/chain"),
    import("../models/provider-policy"),
  ]);
  return { ...failures, ...fallback, ...errors, ...chain, ...policy };
}

afterEach(() => vi.unstubAllEnvs());

describe("failureKindOf", () => {
  const chainFailed = async (...kinds: ProviderErrorKind[]) => {
    const { AllProvidersFailedError, failureKindOf } = await load();
    const failures = kinds.map((kind, i) => ({ model: { provider: "p", model: `m${i}` }, kind, error: kind }));
    return failureKindOf(new AllProvidersFailedError(failures));
  };

  it("reads the kind every model of the chain failed with", async () => {
    expect(await chainFailed("auth")).toBe("provider_auth");
    expect(await chainFailed("auth", "auth")).toBe("provider_auth");
    expect(await chainFailed("rate_limited", "rate_limited")).toBe("rate_limited");
    expect(await chainFailed("usage_limit")).toBe("usage_limit");
    // A limit that lasts on one model and a short one on the other: the chain is out until the long one ends.
    expect(await chainFailed("rate_limited", "usage_limit")).toBe("usage_limit");
  });

  it("calls a chain whose models failed in different ways unavailable", async () => {
    expect(await chainFailed("auth", "rate_limited")).toBe("providers_unavailable");
    expect(await chainFailed("transient")).toBe("providers_unavailable");
    expect(await chainFailed("not_found")).toBe("providers_unavailable");
  });

  it("knows the errors of the setup and of the prompt", async () => {
    const { ContextOverflowError, failureKindOf, NoAllowedProviderError, NoModelError } = await load();
    expect(failureKindOf(new NoModelError())).toBe("no_model");
    expect(failureKindOf(new NoAllowedProviderError())).toBe("provider_not_allowed");
    expect(failureKindOf(new ContextOverflowError())).toBe("context_overflow");
  });

  it("files anything else under other", async () => {
    const { failureKindOf } = await load();
    expect(failureKindOf(new Error("database down"))).toBe("other");
    expect(failureKindOf("text")).toBe("other");
  });
});

describe("abortKind", () => {
  it("reads the kind the abort reason carries, else other", async () => {
    const { abortKind, RunAbort } = await load();
    expect(abortKind(new RunAbort("Stopped because the worker is restarting", "worker_restarted"))).toBe(
      "worker_restarted",
    );
    expect(abortKind(new Error("Cancelled"))).toBe("other");
    expect(abortKind(undefined)).toBe("other");
  });
});

describe("failure kind labels", () => {
  it.each(locales)("%s has a label and a hint for every failure kind", (locale) => {
    const labels = messages[locale].runs.failure;
    expect(Object.keys(labels).sort()).toEqual([...runFailureKind.enumValues].sort());
    for (const { label, hint } of Object.values(labels)) {
      expect(label).toBeTruthy();
      expect(hint).toBeTruthy();
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  SETTINGS_DOMAINS,
  SETTINGS_SCHEMAS,
  settingsIssueValues,
} from "./settings-schema";

describe("DEFAULT_SETTINGS", () => {
  it("passes its own schemas", () => {
    for (const domain of SETTINGS_DOMAINS) {
      expect(SETTINGS_SCHEMAS[domain].safeParse(DEFAULT_SETTINGS[domain]).success, domain).toBe(true);
    }
  });
});

describe("mergeSettings", () => {
  it("merges nested objects field by field", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS.reports, { weekly: { hour: 18 } });
    expect(merged).toEqual({ daily: { enabled: true, hour: 20 }, weekly: { enabled: true, weekday: 1, hour: 18 } });
  });

  it("replaces arrays and skips undefined", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS.budget, { alertPercents: [50], monthlyUsd: undefined });
    expect(merged).toEqual({ monthlyUsd: null, alertPercents: [50] });
  });

  it("sets null over an object field", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS.models, { baseUrls: { openai: null } });
    expect(merged.baseUrls.openai).toBeNull();
  });
});

describe("SETTINGS_SCHEMAS", () => {
  it("reports a bound with its range", () => {
    const parsed = SETTINGS_SCHEMAS.memory.safeParse({ ...DEFAULT_SETTINGS.memory, journalDays: 31 });
    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues[0]!;
    expect(issue.message).toBe("settings.validation.memory.journalDays");
    expect(settingsIssueValues(issue)).toEqual({ min: 1, max: 30 });
  });

  it("refuses a number that is not one (an empty field)", () => {
    const parsed = SETTINGS_SCHEMAS.system.safeParse({ ...DEFAULT_SETTINGS.system, runConcurrency: Number.NaN });
    expect(parsed.error?.issues[0]?.message).toBe("settings.validation.system.runConcurrency");
  });

  it("sorts and dedupes the budget alerts", () => {
    const parsed = SETTINGS_SCHEMAS.budget.parse({ monthlyUsd: 50, alertPercents: [90, 50, 90] });
    expect(parsed.alertPercents).toEqual([50, 90]);
  });

  it("refuses an unknown time zone", () => {
    expect(SETTINGS_SCHEMAS.general.safeParse({ locale: null, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(SETTINGS_SCHEMAS.general.safeParse({ locale: "ro", timezone: "Europe/Bucharest" }).success).toBe(true);
  });

  it("trims the trailing slash of a base URL and refuses other schemes", () => {
    const base = DEFAULT_SETTINGS.models;
    const ok = SETTINGS_SCHEMAS.models.parse({
      ...base,
      baseUrls: { ...base.baseUrls, openai: "https://proxy.example/v1/" },
    });
    expect(ok.baseUrls.openai).toBe("https://proxy.example/v1");
    const bad = SETTINGS_SCHEMAS.models.safeParse({ ...base, baseUrls: { ...base.baseUrls, openai: "ftp://x" } });
    expect(bad.error?.issues[0]?.message).toBe("settings.validation.models.baseUrl");
  });

  it("turns a sandbox policy error into an issue with its values", () => {
    const parsed = SETTINGS_SCHEMAS.sandbox.safeParse({
      ...DEFAULT_SETTINGS.sandbox,
      defaults: { network: { mode: "custom", domains: ["not a domain"] }, packages: { python: [], node: [] } },
    });
    const issue = parsed.error!.issues[0]!;
    expect(issue.message).toBe("sandbox.errors.invalidDomain");
    expect(settingsIssueValues(issue)).toEqual({ domain: "not a domain" });
  });

  it("checks the default agent limits in minutes", () => {
    const limits = { maxSteps: 20, timeoutMs: 30_000, budgetUsd: null };
    const parsed = SETTINGS_SCHEMAS.agents.safeParse({ ...DEFAULT_SETTINGS.agents, defaultLimits: limits });
    const issue = parsed.error!.issues[0]!;
    expect(issue.message).toBe("settings.validation.agents.timeoutMinutes");
    expect(settingsIssueValues(issue)).toEqual({ min: 1, max: 1440 });
  });
});

/**
 * App settings by domain: types, defaults, bounds and validation. Pure and client-safe, so the settings
 * forms validate with the same schemas the server stores through (settings.ts).
 *
 * Each domain is stored as its own row. Validation messages are message keys under
 * `settings.validation.<domain>.<field>`; their values (`{min}`, `{max}`) come from settingsIssueValues.
 */
import type { AgentLimits, ModelRef, ReasoningEffort } from "@abotica/db";
import { isUserError, type Locale, locales } from "@abotica/i18n";
import { z } from "zod";
import { CLOUD_PROVIDER_IDS, type CloudProviderId } from "../models/provider-info";
import { REASONING_EFFORTS } from "../models/reasoning";
import {
  DEFAULT_SANDBOX_POLICY,
  parseSandboxPolicy,
  SANDBOX_RUNTIMES,
  type SandboxPolicy,
  type SandboxRuntime,
} from "../sandbox/sandbox-policy";

export type Range = { min: number; max: number };

/** The roles with a default model chain of their own: the super agent, project managers, specialists. */
export const MODEL_ROLES = ["orchestrator", "manager", "agent"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** The built-in model, or the same model on an Ollama server (see embedding-profiles.ts). */
export const EMBEDDING_PROVIDERS = ["local", "ollama"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** Bounds of every numeric setting, by domain; forms show them and the schemas enforce them. */
export const SETTINGS_LIMITS = {
  agents: {
    parallelDelegations: { min: 1, max: 50 },
    maxRedelegations: { min: 0, max: 50 },
    maxFixRounds: { min: 0, max: 50 },
    maxSteps: { min: 1, max: 2000 },
    timeoutMinutes: { min: 1, max: 24 * 60 },
    budgetUsd: { min: 0.01, max: 1000 },
    instructionsLength: { min: 0, max: 10_000 },
    maxContinuations: { min: 0, max: 20 },
    maxAutoRounds: { min: 2, max: 50 },
    questionEscalationMinutes: { min: 1, max: 24 * 60 },
    userEscalationMinutes: { min: 2, max: 7 * 24 * 60 },
    staleTaskMinutes: { min: 2, max: 24 * 60 },
    deadlineEscalationMinutes: { min: 1, max: 7 * 24 * 60 },
    transientRetries: { min: 0, max: 20 },
    progressMinutes: { min: 0, max: 240 },
  },
  models: { chainLength: { min: 0, max: 10 } },
  memory: {
    journalDays: { min: 1, max: 30 },
    pinnedTokens: { min: 0, max: 20_000 },
    recallTokens: { min: 0, max: 8_000 },
    ephemeralDays: { min: 1, max: 365 },
    unusedDays: { min: 7, max: 365 },
  },
  sandbox: {
    commandTimeoutSec: { min: 10, max: 6 * 3600 },
    memoryMb: { min: 256, max: 65_536 },
    cpus: { min: 0.25, max: 64 },
    pids: { min: 64, max: 32_768 },
    pauseIdleMinutes: { min: 1, max: 24 * 60 },
    stopIdleHours: { min: 1, max: 7 * 24 },
    workspaceRetentionDays: { min: 1, max: 365 },
  },
  previews: { liveHours: { min: 1, max: 7 * 24 }, staticDays: { min: 1, max: 90 } },
  telegram: { allowedUsers: { min: 0, max: 50 } },
  reports: { hour: { min: 0, max: 23 }, weekday: { min: 0, max: 6 }, reminderHours: { min: 0, max: 7 * 24 } },
  budget: { monthlyUsd: { min: 0.01, max: 1_000_000 }, alertPercent: { min: 1, max: 99 }, alerts: { min: 0, max: 4 } },
  security: { sessionDays: { min: 1, max: 365 } },
  system: { runConcurrency: { min: 1, max: 100 } },
} as const satisfies Record<string, Record<string, Range>>;

export type GeneralSettings = {
  /** Interface and notification language. Null follows the browser (web) and falls back to English elsewhere. */
  locale: Locale | null;
  /** IANA time zone for schedules, digests, budgets and every date shown. */
  timezone: string;
};

export type ModelSettings = {
  /** Default chain (first = primary) per role; an empty orchestrator or manager chain follows the agents'. */
  chains: Record<ModelRole, ModelRef[]>;
  /** Effort for agents left on "default"; null for a role follows the agents' effort. */
  reasoningEffort: { agent: ReasoningEffort; manager: ReasoningEffort | null; orchestrator: ReasoningEffort | null };
  /** Ollama has no API key, so it counts as configured only once it is enabled. */
  ollama: { enabled: boolean; baseUrl: string };
  /** API address per cloud provider (a proxy, a region, a compatible gateway); null uses the provider's own. */
  baseUrls: Record<CloudProviderId, string | null>;
};

export type AgentSettings = {
  /** What the user tells every agent, in every system prompt; empty: nothing. */
  instructions: string;
  /** Delegated tasks of one conversation that run at the same time; the others wait for a free place. */
  parallelDelegations: number;
  /** Times an agent may send a delegated task back before the user decides. */
  maxRedelegations: number;
  /** Automatic rounds of fixes a pull request gets for failed checks or review comments. */
  maxFixRounds: number;
  /** Limits a new agent starts with. */
  defaultLimits: AgentLimits;
  /** Times a task's run goes on by itself after stopping at its step or time limit; then its delegator decides. */
  maxContinuations: number;
  /** Wakes agents may start on one task (instructions, redirects) without the user stepping in. */
  maxAutoRounds: number;
  /** Minutes an agent's question waits for its answer before it goes one level up. */
  questionEscalationMinutes: number;
  /** Minutes after which a question still unanswered goes to the user. */
  userEscalationMinutes: number;
  /** Minutes a task in progress may stay quiet (no run, nothing it waits for) before its delegator is told. */
  staleTaskMinutes: number;
  /** Minutes after a missed deadline before the level above the delegator is told. */
  deadlineEscalationMinutes: number;
  /** Automatic retries of a run that failed for a passing reason (a rate limit, a worker restart). */
  transientRetries: number;
  /** Minutes between two progress reports on a task; 0: no limit. */
  progressMinutes: number;
  /** An urgent task starts even when its conversation's places are full (up to twice parallelDelegations). */
  urgentOverflow: boolean;
};

export type MemorySettings = {
  /** What embeds memory, journals and knowledge; changing it embeds everything again. "local" needs no key. */
  embeddingProvider: EmbeddingProvider;
  /** Memory written by agents needs approval before it becomes active. */
  requiresApproval: boolean;
  /** Tokens of pinned memory in every run's system prompt. */
  pinnedTokens: number;
  /** Tokens of memory recalled into each new user message; 0 turns recall off. */
  recallTokens: number;
  /** Days of journal an agent reads at the start of a run. */
  journalDays: number;
  /** Days after which an ephemeral memory expires. */
  ephemeralDays: number;
  /** Days without a recall after which consolidation lists a memory for cleanup. */
  unusedDays: number;
};

export type SandboxSettings = {
  /** Agents get Docker workspaces; off, they work without one. */
  enabled: boolean;
  /** Policy of chats without a project and of projects that follow the default. */
  defaults: SandboxPolicy;
  /** Longest a single command may run, in seconds. */
  commandTimeoutSec: number;
  /** Container runtime ("auto" uses gVisor when installed). */
  runtime: SandboxRuntime;
  /** Memory limit per workspace container. */
  memoryMb: number;
  /** CPU limit per workspace container. */
  cpus: number;
  /** Process limit per workspace container. */
  pids: number;
  /** A container without commands is paused after this many minutes, unless something runs in its background. */
  pauseIdleMinutes: number;
  /** A container without commands is stopped after this many hours, with whatever still runs in it. */
  stopIdleHours: number;
  /** A chat's workspace is deleted after this many days unused. */
  workspaceRetentionDays: number;
};

export type PreviewSettings = {
  /** Hours a live preview link (a running server) stays open. */
  liveHours: number;
  /** Days a static preview link (a snapshot of files) stays open. */
  staticDays: number;
};

type TelegramSettings = {
  /** Telegram users allowed to talk to the bot; the bot token itself is in the vault (TELEGRAM_BOT_TOKEN). */
  allowedUserIds: number[];
  /** Chat that gets notifications (a user id, or a forum group id); null sends them to the first allowed user. */
  notifyChatId: string | null;
};

type ReportSettings = {
  /** The day's summary, at `hour` local time. */
  daily: { enabled: boolean; hour: number };
  /** The week's summary, on `weekday` (0 = Sunday) at `hour` local time. */
  weekly: { enabled: boolean; weekday: number; hour: number };
  /** Hours after which what waits for the user (questions, approvals) is brought up again; 0 turns it off. */
  reminderHours: number;
};

export type BudgetSettings = {
  /** Monthly budget across all projects, background jobs included, USD. Null means no limit. */
  monthlyUsd: number | null;
  /** Percentages of a budget that send a warning; reaching 100% always stops runs and warns. */
  alertPercents: number[];
};

type SecuritySettings = {
  /** Days a sign-in stays valid without being used. */
  sessionDays: number;
};

export type SystemSettings = {
  /** Agent runs one worker executes at the same time. */
  runConcurrency: number;
  /** Look for new Abotica releases every few hours and say so in the app and on Telegram. */
  updateChecks: boolean;
};

export type AppSettings = {
  general: GeneralSettings;
  models: ModelSettings;
  agents: AgentSettings;
  memory: MemorySettings;
  sandbox: SandboxSettings;
  previews: PreviewSettings;
  telegram: TelegramSettings;
  reports: ReportSettings;
  budget: BudgetSettings;
  security: SecuritySettings;
  system: SystemSettings;
};

export type SettingsDomain = keyof AppSettings;

export const SETTINGS_DOMAINS = [
  "general",
  "models",
  "agents",
  "memory",
  "sandbox",
  "previews",
  "telegram",
  "reports",
  "budget",
  "security",
  "system",
] as const satisfies readonly SettingsDomain[];

export const DEFAULT_SETTINGS: AppSettings = {
  general: { locale: null, timezone: "UTC" },
  models: {
    chains: { orchestrator: [], manager: [], agent: [] },
    reasoningEffort: { agent: "default", manager: null, orchestrator: null },
    ollama: { enabled: false, baseUrl: "http://localhost:11434" },
    baseUrls: { anthropic: null, openai: null, deepseek: null, moonshot: null },
  },
  agents: {
    instructions: "",
    parallelDelegations: 5,
    maxRedelegations: 5,
    maxFixRounds: 5,
    // Room for real work (a build, a crawl, a refactor): cost is held by the monthly budget the user
    // sets, not by a small limit per run, so a run has no budget of its own unless an agent is given one.
    defaultLimits: { maxSteps: 150, timeoutMs: 120 * 60_000, budgetUsd: null },
    maxContinuations: 3,
    maxAutoRounds: 10,
    questionEscalationMinutes: 30,
    userEscalationMinutes: 120,
    staleTaskMinutes: 60,
    deadlineEscalationMinutes: 60,
    transientRetries: 6,
    progressMinutes: 10,
    urgentOverflow: true,
  },
  memory: {
    embeddingProvider: "local",
    requiresApproval: false,
    pinnedTokens: 2000,
    recallTokens: 1000,
    journalDays: 5,
    ephemeralDays: 30,
    unusedDays: 60,
  },
  sandbox: {
    enabled: true,
    defaults: DEFAULT_SANDBOX_POLICY,
    // A single command may be a long build, test suite or data job.
    commandTimeoutSec: 3600,
    runtime: "auto",
    memoryMb: 4096,
    cpus: 4,
    pids: 4096,
    pauseIdleMinutes: 15,
    stopIdleHours: 6,
    workspaceRetentionDays: 30,
  },
  previews: { liveHours: 24, staticDays: 7 },
  telegram: { allowedUserIds: [], notifyChatId: null },
  reports: { daily: { enabled: true, hour: 20 }, weekly: { enabled: true, weekday: 1, hour: 9 }, reminderHours: 4 },
  budget: { monthlyUsd: null, alertPercents: [80] },
  security: { sessionDays: 30 },
  system: { runConcurrency: 4, updateChecks: true },
};

/** Message key -> the bounds it reports, so a translated message can say `{min}` and `{max}`. */
const RANGES = new Map<string, Range>();

const message = (domain: SettingsDomain, field: string) => `settings.validation.${domain}.${field}`;

/** `shown` is the range in the unit the form uses, when the stored unit differs (minutes shown, ms stored). */
function int(domain: SettingsDomain, field: string, range: Range, shown: Range = range) {
  const key = message(domain, field);
  RANGES.set(key, shown);
  return z.number(key).int(key).min(range.min, key).max(range.max, key);
}

function decimal(domain: SettingsDomain, field: string, range: Range) {
  const key = message(domain, field);
  RANGES.set(key, range);
  return z.number(key).min(range.min, key).max(range.max, key);
}

/** The values a validation message of the settings shows; undefined when it has none. */
export function settingsIssueValues(issue: {
  message: string;
  params?: unknown;
}): Record<string, string | number> | undefined {
  const range = RANGES.get(issue.message);
  if (range) return { min: range.min, max: range.max };
  const params = issue.params as Record<string, string | number> | undefined;
  return params && typeof params === "object" ? params : undefined;
}

export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const L = SETTINGS_LIMITS;

const httpUrl = (key: string) =>
  z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }, key)
    .transform((value) => value.replace(/\/+$/, ""));

const modelChain = z
  .array(z.object({ provider: z.string().min(1), model: z.string().trim().min(1, message("models", "pickModel")) }))
  .max(L.models.chainLength.max, message("models", "chainLength"));

const effort = z.enum(REASONING_EFFORTS);

/** The sandbox policy through its own parser, whose UserErrors become issues with their values. */
const sandboxPolicy = z.unknown().transform((value, ctx): SandboxPolicy => {
  try {
    return parseSandboxPolicy(value);
  } catch (error) {
    if (!isUserError(error)) throw error;
    ctx.addIssue({ code: "custom", message: error.key, params: error.values });
    return z.NEVER;
  }
});

export const SETTINGS_SCHEMAS = {
  general: z.object({
    locale: z.enum(locales).nullable(),
    timezone: z.string().trim().refine(isTimeZone, message("general", "timezone")),
  }),
  models: z.object({
    chains: z.object({ orchestrator: modelChain, manager: modelChain, agent: modelChain }),
    reasoningEffort: z.object({ agent: effort, manager: effort.nullable(), orchestrator: effort.nullable() }),
    ollama: z.object({ enabled: z.boolean(), baseUrl: httpUrl(message("models", "ollamaUrl")) }),
    baseUrls: z.object(
      Object.fromEntries(CLOUD_PROVIDER_IDS.map((id) => [id, httpUrl(message("models", "baseUrl")).nullable()])) as Record<
        CloudProviderId,
        z.ZodNullable<ReturnType<typeof httpUrl>>
      >,
    ),
  }),
  agents: z.object({
    instructions: z.string().trim().max(L.agents.instructionsLength.max, message("agents", "instructions")),
    parallelDelegations: int("agents", "parallelDelegations", L.agents.parallelDelegations),
    maxRedelegations: int("agents", "maxRedelegations", L.agents.maxRedelegations),
    maxFixRounds: int("agents", "maxFixRounds", L.agents.maxFixRounds),
    defaultLimits: z.object({
      maxSteps: int("agents", "maxSteps", L.agents.maxSteps),
      timeoutMs: int(
        "agents",
        "timeoutMinutes",
        { min: L.agents.timeoutMinutes.min * 60_000, max: L.agents.timeoutMinutes.max * 60_000 },
        L.agents.timeoutMinutes,
      ),
      budgetUsd: decimal("agents", "budgetUsd", L.agents.budgetUsd).nullable(),
    }),
    maxContinuations: int("agents", "maxContinuations", L.agents.maxContinuations),
    maxAutoRounds: int("agents", "maxAutoRounds", L.agents.maxAutoRounds),
    questionEscalationMinutes: int("agents", "questionEscalationMinutes", L.agents.questionEscalationMinutes),
    userEscalationMinutes: int("agents", "userEscalationMinutes", L.agents.userEscalationMinutes),
    staleTaskMinutes: int("agents", "staleTaskMinutes", L.agents.staleTaskMinutes),
    deadlineEscalationMinutes: int("agents", "deadlineEscalationMinutes", L.agents.deadlineEscalationMinutes),
    transientRetries: int("agents", "transientRetries", L.agents.transientRetries),
    progressMinutes: int("agents", "progressMinutes", L.agents.progressMinutes),
    urgentOverflow: z.boolean(),
  }),
  memory: z.object({
    embeddingProvider: z.enum(EMBEDDING_PROVIDERS),
    requiresApproval: z.boolean(),
    pinnedTokens: int("memory", "pinnedTokens", L.memory.pinnedTokens),
    recallTokens: int("memory", "recallTokens", L.memory.recallTokens),
    journalDays: int("memory", "journalDays", L.memory.journalDays),
    ephemeralDays: int("memory", "ephemeralDays", L.memory.ephemeralDays),
    unusedDays: int("memory", "unusedDays", L.memory.unusedDays),
  }),
  sandbox: z.object({
    enabled: z.boolean(),
    defaults: sandboxPolicy,
    commandTimeoutSec: int("sandbox", "commandTimeoutSec", L.sandbox.commandTimeoutSec),
    runtime: z.enum(SANDBOX_RUNTIMES),
    memoryMb: int("sandbox", "memoryMb", L.sandbox.memoryMb),
    cpus: decimal("sandbox", "cpus", L.sandbox.cpus),
    pids: int("sandbox", "pids", L.sandbox.pids),
    pauseIdleMinutes: int("sandbox", "pauseIdleMinutes", L.sandbox.pauseIdleMinutes),
    stopIdleHours: int("sandbox", "stopIdleHours", L.sandbox.stopIdleHours),
    workspaceRetentionDays: int("sandbox", "workspaceRetentionDays", L.sandbox.workspaceRetentionDays),
  }),
  previews: z.object({
    liveHours: int("previews", "liveHours", L.previews.liveHours),
    staticDays: int("previews", "staticDays", L.previews.staticDays),
  }),
  telegram: z.object({
    allowedUserIds: z
      .array(z.number().int().positive(message("telegram", "userIds")))
      .max(L.telegram.allowedUsers.max, message("telegram", "userIds")),
    notifyChatId: z
      .string()
      .trim()
      .regex(/^-?\d{1,20}$/, message("telegram", "chatId"))
      .nullable(),
  }),
  reports: z.object({
    daily: z.object({ enabled: z.boolean(), hour: int("reports", "hour", L.reports.hour) }),
    weekly: z.object({
      enabled: z.boolean(),
      weekday: int("reports", "weekday", L.reports.weekday),
      hour: int("reports", "hour", L.reports.hour),
    }),
    reminderHours: int("reports", "reminderHours", L.reports.reminderHours),
  }),
  budget: z.object({
    monthlyUsd: decimal("budget", "monthlyUsd", L.budget.monthlyUsd).nullable(),
    alertPercents: z
      .array(int("budget", "alertPercent", L.budget.alertPercent))
      .max(L.budget.alerts.max, message("budget", "alerts"))
      .transform((list) => [...new Set(list)].sort((a, b) => a - b)),
  }),
  security: z.object({ sessionDays: int("security", "sessionDays", L.security.sessionDays) }),
  system: z.object({
    runConcurrency: int("system", "runConcurrency", L.system.runConcurrency),
    updateChecks: z.boolean(),
  }),
} as const satisfies { [D in SettingsDomain]: z.ZodType<AppSettings[D], unknown> };

/** A change to a domain: nested objects may name only the fields that change; arrays are replaced whole. */
export type SettingsPatch<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? SettingsPatch<T[K]> | T[K] : T[K];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `patch` on top of `base`: plain objects merge field by field, everything else (arrays included) replaces. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? mergeSettings(out[key], value) : value;
  }
  return out as T;
}

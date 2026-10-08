import { db, type ModelRef, type ReasoningEffort, settings } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { defaultLocale, type Locale } from "@abotica/i18n";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../sandbox/sandbox-policy";

export type AppSettings = {
  /** Default model chain (first = primary) for agents that follow the default (see resolveModelChain). */
  defaultModels: ModelRef[];
  /** The super agent's default chain; empty follows defaultModels. */
  orchestratorModels: ModelRef[];
  /** The default chain of agents that manage a project; empty follows defaultModels. */
  managerModels: ModelRef[];
  /** Reasoning effort for agents left on "default"; "default" here lets the model decide. */
  defaultReasoningEffort: ReasoningEffort;
  /** The super agent's effort when it is left on "default"; null follows defaultReasoningEffort. */
  orchestratorReasoningEffort: ReasoningEffort | null;
  /** The managers' effort when they are left on "default"; null follows defaultReasoningEffort. */
  managerReasoningEffort: ReasoningEffort | null;
  /**
   * Delegated tasks of one conversation that run at the same time; the others wait for a free place
   * (see tasks/delegation-slots.ts).
   */
  parallelDelegations: number;
  /** Days of journal an agent reads at the start of a run. */
  journalDays: number;
  /** Memory written by agents needs approval before it becomes active. */
  memoryRequiresApproval: boolean;
  /**
   * Tokens of pinned memory in every run's system prompt (see pinnedMemories). While all the memory a run
   * may read fits, all of it goes in, pinned or not.
   */
  memoryPinnedTokens: number;
  /** Tokens of memory recalled into each new user message (see recallForRun); 0 turns recall off. */
  memoryRecallTokens: number;
  /** Hour (0-23, local time) for the daily digest. */
  digestHour: number;
  timezone: string;
  /**
   * Monthly budget across all projects, background jobs included, USD (see budgets.ts). Runs stop and
   * do not start once it is reached, with a warning at 80%. Null means no limit.
   */
  monthlyBudgetUsd: number | null;
  /** Ollama has no API key, so it counts as configured only once it is activated in Settings. */
  ollamaEnabled: boolean;
  /** Where the Ollama server listens, as the user's machine sees it (see reachableUrl for containers). */
  ollamaBaseUrl: string;
  /** What embeds memory, journals and knowledge; changing it embeds everything again (see embeddings). */
  embeddingProvider: "openai" | "ollama";
  /** Agent runs one worker executes at the same time. */
  runConcurrency: number;
  /** Telegram users allowed to talk to the bot; the bot token itself is in the vault (TELEGRAM_BOT_TOKEN). */
  telegramAllowedUserIds: number[];
  /** Chat that gets notifications (a user id, or a forum group id); null sends them to the first allowed user. */
  telegramNotifyChatId: string | null;
  /** Interface and notification language. Null follows the browser (web) and falls back to English elsewhere. */
  locale: Locale | null;
  /** Look for new Abotica releases on GitHub every few hours and say so in the app and on Telegram. */
  updateChecks: boolean;
  sandbox: SandboxSettings;
};

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModels: [],
  orchestratorModels: [],
  managerModels: [],
  defaultReasoningEffort: "default",
  orchestratorReasoningEffort: null,
  managerReasoningEffort: null,
  parallelDelegations: 2,
  journalDays: 5,
  memoryRequiresApproval: false,
  memoryPinnedTokens: 2000,
  memoryRecallTokens: 1000,
  digestHour: 20,
  timezone: "Europe/Bucharest",
  monthlyBudgetUsd: null,
  ollamaEnabled: false,
  ollamaBaseUrl: "http://localhost:11434",
  embeddingProvider: "openai",
  runConcurrency: 4,
  telegramAllowedUserIds: [],
  telegramNotifyChatId: null,
  locale: null,
  updateChecks: true,
  sandbox: DEFAULT_SANDBOX_SETTINGS,
};

/** Language for places without a browser to ask (Telegram, digests, notifications). */
export function settingsLocale(settings: AppSettings): Locale {
  return settings.locale ?? defaultLocale;
}

/** The settings as stored, without the defaults filled in: a key is there once something saved it. */
export async function storedSettings(): Promise<Partial<AppSettings>> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "app"));
  return (row?.value as Partial<AppSettings>) ?? {};
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await storedSettings();
  // Nested so a sandbox setting added later gets its default in rows saved before it existed.
  return { ...DEFAULT_SETTINGS, ...stored, sandbox: { ...DEFAULT_SANDBOX_SETTINGS, ...stored.sandbox } };
}

/**
 * Saves the changed settings on top of the stored ones. Only what was set is stored: a setting never
 * saved keeps following its default, and the .env import (settings-env.ts) can tell it was never set.
 */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const stored = { ...(await storedSettings()), ...patch };
  await db
    .insert(settings)
    .values({ key: "app", value: stored })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored } });
  return { ...DEFAULT_SETTINGS, ...stored, sandbox: { ...DEFAULT_SANDBOX_SETTINGS, ...stored.sandbox } };
}

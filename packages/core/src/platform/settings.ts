import { db, type ModelRef, type ReasoningEffort, settings } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { defaultLocale, type Locale } from "@abotica/i18n";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "../sandbox/sandbox-policy";

export type AppSettings = {
  /** Default model chain (first = primary) for agents that follow the default. */
  defaultModels: ModelRef[];
  /** Reasoning effort for agents left on "default"; "default" here lets the model decide. */
  defaultReasoningEffort: ReasoningEffort;
  /** Days of journal an agent reads at the start of a run. */
  journalDays: number;
  /** Memory written by agents needs approval before it becomes active. */
  memoryRequiresApproval: boolean;
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
  /** Interface and notification language. Null follows the browser (web) and falls back to English elsewhere. */
  locale: Locale | null;
  sandbox: SandboxSettings;
};

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModels: [],
  defaultReasoningEffort: "default",
  journalDays: 5,
  memoryRequiresApproval: false,
  digestHour: 20,
  timezone: "Europe/Bucharest",
  monthlyBudgetUsd: null,
  ollamaEnabled: false,
  locale: null,
  sandbox: DEFAULT_SANDBOX_SETTINGS,
};

/** Language for places without a browser to ask (Telegram, digests, notifications). */
export function settingsLocale(settings: AppSettings): Locale {
  return settings.locale ?? defaultLocale;
}

export async function getSettings(): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "app"));
  const stored = (row?.value as Partial<AppSettings>) ?? {};
  // Nested so a sandbox setting added later gets its default in rows saved before it existed.
  return { ...DEFAULT_SETTINGS, ...stored, sandbox: { ...DEFAULT_SANDBOX_SETTINGS, ...stored.sandbox } };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  await db
    .insert(settings)
    .values({ key: "app", value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next } });
  return next;
}

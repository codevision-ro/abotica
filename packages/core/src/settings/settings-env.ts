/**
 * The upgrade path from .env, where Telegram, the Ollama address, the embedding provider and the run
 * concurrency were set before they moved to Settings. env() no longer has these variables; the import
 * reads process.env once and copies what the platform does not have yet.
 */
import { appState, db } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { parseHttpUrl } from "../infra/reachable-url";
import { audit } from "../platform/audit";
import { setSecret } from "../platform/vault";
import { getTelegramToken, TELEGRAM_TOKEN_SECRET } from "../telegram/telegram-config";
import { isTelegramChatId, parseTelegramUserIds } from "../telegram/telegram-ids";
import {
  SETTINGS_LIMITS,
  type SettingsDomain,
  settingsTranslator,
  type SettingsPatch,
  type StoredSettings,
  storedSettings,
  updateSettings,
} from "./settings";

/** app_state row that records the import, so it runs once per installation. */
const IMPORTED_KEY = "env_imported";

/**
 * The host the old compose files gave the containers for Ollama on this machine. The address is stored
 * as the user's machine sees it now, and reachableUrl points it to the host inside containers.
 */
const OLD_CONTAINER_HOST = "host.docker.internal";

const has = (stored: StoredSettings, domain: SettingsDomain, ...path: string[]): boolean => {
  let node: unknown = stored[domain];
  for (const key of path) {
    if (typeof node !== "object" || node === null || !(key in node)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return true;
};

/**
 * What to copy from the old variables in `source`: each one that is set while the stored settings (as
 * stored, without the defaults filled in) lack its field. A value that cannot be read is left out, so
 * the default applies. No IO, see importLegacyEnv.
 */
export function settingsFromEnv(
  stored: StoredSettings,
  source: Readonly<Record<string, string | undefined>>,
): { patch: StoredSettings; imported: string[] } {
  const patch: StoredSettings = {};
  const imported: string[] = [];
  const value = (name: string, domain: SettingsDomain, ...path: string[]) =>
    has(stored, domain, ...path) ? undefined : source[name]?.trim() || undefined;

  const ollama = value("OLLAMA_BASE_URL", "models", "ollama", "baseUrl");
  const url = ollama ? parseHttpUrl(ollama) : null;
  if (url) {
    const parsed = new URL(url);
    if (parsed.hostname === OLD_CONTAINER_HOST) parsed.hostname = "localhost";
    // An address set in .env meant Ollama was in use: it is enabled too, unless Settings says otherwise.
    const enabled = has(stored, "models", "ollama", "enabled") ? {} : { enabled: true };
    patch.models = { ollama: { baseUrl: parseHttpUrl(parsed.toString())!, ...enabled } };
    imported.push("OLLAMA_BASE_URL");
  }

  const embedding = value("EMBEDDING_PROVIDER", "memory", "embeddingProvider");
  // OpenAI no longer embeds: an install that had it gets the built-in model (see settleEmbeddingModel).
  if (embedding === "local" || embedding === "ollama") {
    patch.memory = { embeddingProvider: embedding };
    imported.push("EMBEDDING_PROVIDER");
  }

  const concurrency = Number(value("RUN_CONCURRENCY", "system", "runConcurrency"));
  if (Number.isInteger(concurrency) && concurrency > 0) {
    patch.system = { runConcurrency: Math.min(concurrency, SETTINGS_LIMITS.system.runConcurrency.max) };
    imported.push("RUN_CONCURRENCY");
  }

  const ids = parseTelegramUserIds(value("TELEGRAM_ALLOWED_USER_IDS", "telegram", "allowedUserIds") ?? "");
  if (ids?.length) {
    patch.telegram = { allowedUserIds: ids };
    imported.push("TELEGRAM_ALLOWED_USER_IDS");
  }

  const chat = value("TELEGRAM_NOTIFY_CHAT_ID", "telegram", "notifyChatId");
  if (chat && isTelegramChatId(chat)) {
    patch.telegram = { ...patch.telegram, notifyChatId: chat };
    imported.push("TELEGRAM_NOTIFY_CHAT_ID");
  }
  return { patch, imported };
}

/**
 * Copies the old variables at the worker's start, once per installation: the settings the stored rows
 * lack (settingsFromEnv) and the bot token while the vault has none. Nothing set in Settings is
 * overwritten, and what is removed there later stays removed while the old line is still in .env.
 * Returns the names it imported.
 */
export async function importLegacyEnv(source: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const [done] = await db.select({ key: appState.key }).from(appState).where(eq(appState.key, IMPORTED_KEY));
  if (done) return [];
  const { patch, imported } = settingsFromEnv(await storedSettings(), source);
  for (const [domain, change] of Object.entries(patch) as [SettingsDomain, SettingsPatch<unknown>][]) {
    await updateSettings(domain, change as never, { actor: "system" });
  }

  const token = source.TELEGRAM_BOT_TOKEN?.trim();
  if (token && !(await getTelegramToken())) {
    const t = await settingsTranslator();
    await setSecret(TELEGRAM_TOKEN_SECRET, token, t("settings.telegram.secretDescription"));
    await audit({
      actor: "system",
      action: "telegram.token-set",
      entityType: "secret",
      entityId: TELEGRAM_TOKEN_SECRET,
      data: { source: ".env" },
    });
    imported.push("TELEGRAM_BOT_TOKEN");
  }

  const value = { at: new Date().toISOString(), imported };
  await db.insert(appState).values({ key: IMPORTED_KEY, value }).onConflictDoNothing();
  return imported;
}

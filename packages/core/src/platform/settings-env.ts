/**
 * The upgrade path from .env, where Telegram, the Ollama address, the embedding provider and the run
 * concurrency were set before they moved to Settings. env() no longer has these variables; the import
 * reads process.env once and copies what the platform does not have yet.
 */
import { db, settings } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { getTranslator } from "@abotica/i18n";
import { parseHttpUrl } from "../infra/reachable-url";
import { getTelegramToken, TELEGRAM_TOKEN_SECRET } from "../telegram/telegram-config";
import { isTelegramChatId, parseTelegramUserIds } from "../telegram/telegram-ids";
import { audit } from "./audit";
import { type AppSettings, getSettings, settingsLocale, storedSettings, updateSettings } from "./settings";
import { setSecret } from "./vault";

/** The settings that were environment variables before they moved to Settings. */
type EnvSettings = Pick<
  AppSettings,
  "ollamaBaseUrl" | "embeddingProvider" | "runConcurrency" | "telegramAllowedUserIds" | "telegramNotifyChatId"
>;

/** Settings row that records the import, so it runs once per installation. */
const IMPORTED_KEY = "env_imported";

export const RUN_CONCURRENCY_MAX = 20;

/**
 * The host the old compose files gave the containers for Ollama on this machine. The address is stored
 * as the user's machine sees it now, and reachableUrl points it to the host inside containers.
 */
const OLD_CONTAINER_HOST = "host.docker.internal";

/**
 * What to copy from the old variables in `source`: each one that is set while the stored settings (as
 * stored, without the defaults filled in) lack its key. A value that cannot be read is left out, so the
 * default applies. No IO, see importLegacyEnv.
 */
export function settingsFromEnv(
  stored: Readonly<Record<string, unknown>>,
  source: Readonly<Record<string, string | undefined>>,
): { patch: Partial<EnvSettings>; imported: string[] } {
  const patch: Partial<EnvSettings> = {};
  const imported: string[] = [];
  const value = (name: string, key: keyof EnvSettings) => (key in stored ? undefined : source[name]?.trim() || undefined);

  const ollama = value("OLLAMA_BASE_URL", "ollamaBaseUrl");
  const url = ollama ? parseHttpUrl(ollama) : null;
  if (url) {
    const parsed = new URL(url);
    if (parsed.hostname === OLD_CONTAINER_HOST) parsed.hostname = "localhost";
    patch.ollamaBaseUrl = parseHttpUrl(parsed.toString())!;
    imported.push("OLLAMA_BASE_URL");
  }

  const embedding = value("EMBEDDING_PROVIDER", "embeddingProvider");
  if (embedding === "local" || embedding === "openai" || embedding === "ollama") {
    patch.embeddingProvider = embedding;
    imported.push("EMBEDDING_PROVIDER");
  }

  const concurrency = Number(value("RUN_CONCURRENCY", "runConcurrency"));
  if (Number.isInteger(concurrency) && concurrency > 0) {
    patch.runConcurrency = Math.min(concurrency, RUN_CONCURRENCY_MAX);
    imported.push("RUN_CONCURRENCY");
  }

  const ids = parseTelegramUserIds(value("TELEGRAM_ALLOWED_USER_IDS", "telegramAllowedUserIds") ?? "");
  if (ids?.length) {
    patch.telegramAllowedUserIds = ids;
    imported.push("TELEGRAM_ALLOWED_USER_IDS");
  }

  const chat = value("TELEGRAM_NOTIFY_CHAT_ID", "telegramNotifyChatId");
  if (chat && isTelegramChatId(chat)) {
    patch.telegramNotifyChatId = chat;
    imported.push("TELEGRAM_NOTIFY_CHAT_ID");
  }
  return { patch, imported };
}

/**
 * Copies the old variables at the worker's start, once per installation: the settings the stored row
 * lacks (settingsFromEnv) and the bot token while the vault has none. Nothing set in Settings is
 * overwritten, and what is removed there later stays removed while the old line is still in .env.
 * Returns the names it imported.
 */
export async function importLegacyEnv(source: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const [done] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, IMPORTED_KEY));
  if (done) return [];
  const { patch, imported } = settingsFromEnv(await storedSettings(), source);
  if (imported.length) await updateSettings(patch);

  const token = source.TELEGRAM_BOT_TOKEN?.trim();
  if (token && !(await getTelegramToken())) {
    const t = getTranslator(settingsLocale(await getSettings()));
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
  await db.insert(settings).values({ key: IMPORTED_KEY, value }).onConflictDoNothing();
  return imported;
}

import { createHash } from "node:crypto";
/**
 * The Telegram bot's configuration, set in Settings > Telegram: the token in the vault, who may talk to
 * the bot and where notifications go in the settings. The worker runs the bot (apps/worker/src/telegram)
 * and stores what it is doing here, for the settings page.
 */
import { UserError } from "@abotica/i18n";
import { env } from "../infra/env";
import { publish } from "../infra/events";
import { redis } from "../infra/redis";
import { audit } from "../platform/audit";
import { getSettings, updateSettings } from "../settings/settings";
import { deleteSecret, getSecret, setSecret } from "../platform/vault";
import { notifyChatOf } from "./telegram-ids";

/** Vault name of the bot token. */
export const TELEGRAM_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";

const STATUS_KEY = "abotica:telegram:status";

/** A token as @BotFather hands it out: the bot's numeric id, a colon, then the secret part. */
const TOKEN_FORMAT = /^\d+:[\w-]+$/;

export async function getTelegramToken(): Promise<string | undefined> {
  return getSecret(TELEGRAM_TOKEN_SECRET);
}

/** Who may talk to the bot and the chat notifications go to (null: nowhere). */
export async function telegramAccess(): Promise<{ allowedUserIds: number[]; notifyChatId: number | null }> {
  const { telegram } = await getSettings();
  return { allowedUserIds: telegram.allowedUserIds, notifyChatId: notifyChatOf(telegram) };
}

/**
 * The bot behind a token, from Telegram's getMe, so a wrong or revoked token is refused when it is
 * saved instead of failing later in the worker. The token never appears in the errors.
 */
export async function fetchTelegramBot(token: string): Promise<{ username: string }> {
  if (!TOKEN_FORMAT.test(token)) throw new UserError("settings.telegram.errors.tokenFormat");
  let res: Response;
  try {
    res = await fetch(`${env().TELEGRAM_API_URL}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new UserError("settings.telegram.errors.unreachable");
  }
  if (res.status === 401 || res.status === 404) throw new UserError("settings.telegram.errors.tokenRefused");
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
  if (!res.ok || !body?.ok || !body.result?.username) throw new UserError("settings.telegram.errors.unreachable");
  return { username: body.result.username };
}

/** Saves the bot token; the worker restarts the bot with it. Audited without the value. */
export async function saveTelegramToken(token: string, description: string): Promise<void> {
  await setSecret(TELEGRAM_TOKEN_SECRET, token, description);
  await audit({ actor: "user", action: "telegram.token-set", entityType: "secret", entityId: TELEGRAM_TOKEN_SECRET });
  await announceTelegramChange();
}

/** Removes the bot token; the worker stops the bot. */
export async function removeTelegramToken(): Promise<void> {
  if (await deleteSecret(TELEGRAM_TOKEN_SECRET)) {
    await audit({ actor: "user", action: "telegram.token-removed", entityType: "secret", entityId: TELEGRAM_TOKEN_SECRET });
  }
  await announceTelegramChange();
}

export type TelegramAccess = { allowedUserIds: number[]; notifyChatId: string | null };

/**
 * Saves who may talk to the bot and the notification chat (updateSettings audits the change). The
 * worker reads them from the settings on every update, so they apply at once, without a restart.
 */
export async function saveTelegramAccess(access: TelegramAccess): Promise<void> {
  await updateSettings("telegram", { allowedUserIds: access.allowedUserIds, notifyChatId: access.notifyChatId });
}

/** Tells the worker the token may have changed (also after an edit on the vault page). */
export async function announceTelegramChange(): Promise<void> {
  await publish({ type: "telegram.config-changed" });
}

/** What the worker's bot is doing: polling as @username, or stopped by an error (a revoked token, a second instance). */
export type TelegramBotStatus =
  { state: "running"; username: string; startedAt: string } | { state: "error"; error: string; at: string };

/** Ties a stored status to the token it is about, without keeping the token in Redis. */
const tokenFingerprint = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

/**
 * The status of the bot running with the token in the vault. Null when none does: no token, no worker,
 * or the worker has not started the bot for a token saved moments ago (the status left is the old one's).
 */
export async function getTelegramBotStatus(): Promise<TelegramBotStatus | null> {
  const [raw, token] = await Promise.all([redis().get(STATUS_KEY), getTelegramToken()]);
  if (!raw || !token) return null;
  try {
    const { token: fingerprint, ...status } = JSON.parse(raw) as TelegramBotStatus & { token: string };
    return fingerprint === tokenFingerprint(token) ? status : null;
  } catch {
    return null;
  }
}

/** Worker only: stores the status of the bot running with `token` and announces it, so the page refreshes. */
export async function setTelegramBotStatus(token: string, status: TelegramBotStatus): Promise<void> {
  await redis().set(STATUS_KEY, JSON.stringify({ ...status, token: tokenFingerprint(token) }));
  await publish({ type: "telegram.status" });
}

/** Worker only: no bot runs (no token, or the worker is stopping). */
export async function clearTelegramBotStatus(): Promise<void> {
  await redis().del(STATUS_KEY);
  await publish({ type: "telegram.status" });
}

/**
 * Telegram ids as the user types them in Settings > Telegram. Client-safe, so the form checks them with
 * the rules the server applies.
 */

/**
 * Allowed user ids from text such as "123, 456" (commas, spaces or new lines between them), without
 * duplicates. Null when one of them is not a positive integer.
 */
export function parseTelegramUserIds(text: string): number[] | null {
  const ids: number[] = [];
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(part)) return null;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A chat id: a user's (positive) or a group's (negative; supergroups and forums start with -100). */
export function isTelegramChatId(text: string): boolean {
  return /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) !== 0;
}

/** Where notifications go: the chat set in Settings, else the private chat with the first allowed user. */
export function notifyChatOf(settings: { notifyChatId: string | null; allowedUserIds: number[] }): number | null {
  const id = settings.notifyChatId ?? settings.allowedUserIds[0];
  return id === undefined ? null : Number(id);
}

/**
 * The conversation key of a chat: one conversation per chat, and per forum topic or reply thread.
 * Project topics are no exception: the super agent answers there too.
 */
export function telegramConversationKey(chatId: number, threadId: number | null | undefined): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

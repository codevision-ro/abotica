/** Pure helpers for files users send the bot. No server imports, so they are testable on their own. */
import { extensionFor } from "@abotica/core/file-types";

/** The Bot API lets bots download files up to 20 MB (getFile, https://core.telegram.org/bots/api#getfile). */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Name to store a Telegram file under: the name Telegram gives, else `fallback` with the extension of
 * the media type (photos have no name and are always JPEG).
 */
export function incomingFileName(name: string | undefined, mimeType: string | undefined, fallback: string): string {
  const given = name?.trim();
  if (given) return given;
  const ext = mimeType ? extensionFor(mimeType) : null;
  return ext ? `${fallback}.${ext}` : fallback;
}

/**
 * Collects the messages of an album: Telegram sends each photo or document of a media group as its own
 * update, so they are held until none arrived for `waitMs` and then handed to `flush` together, in order.
 */
export function mediaGroupCollector<T>(flush: (items: T[]) => void, waitMs = 1_000) {
  const groups = new Map<string, { items: T[]; timer?: ReturnType<typeof setTimeout> }>();
  return (groupId: string, item: T) => {
    const group = groups.get(groupId) ?? { items: [] };
    clearTimeout(group.timer);
    group.items.push(item);
    group.timer = setTimeout(() => {
      groups.delete(groupId);
      flush(group.items);
    }, waitMs);
    groups.set(groupId, group);
  };
}

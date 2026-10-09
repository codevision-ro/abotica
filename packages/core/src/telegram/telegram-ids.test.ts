import { describe, expect, it } from "vitest";
import { isTelegramChatId, notifyChatOf, parseTelegramUserIds, telegramConversationKey } from "./telegram-ids";

describe("parseTelegramUserIds", () => {
  it("reads ids separated by commas, spaces or new lines, without duplicates", () => {
    expect(parseTelegramUserIds("123, 456")).toEqual([123, 456]);
    expect(parseTelegramUserIds(" 123\n456  789,123 ")).toEqual([123, 456, 789]);
  });

  it("reads an empty list from empty text", () => {
    expect(parseTelegramUserIds("")).toEqual([]);
    expect(parseTelegramUserIds(" , ")).toEqual([]);
  });

  it("refuses anything that is not a positive integer", () => {
    for (const text of ["123, abc", "-5", "0", "1.5", "12e3", "@someone", "99999999999999999999"]) {
      expect(parseTelegramUserIds(text)).toBeNull();
    }
  });
});

describe("isTelegramChatId", () => {
  it("accepts user ids and negative group ids", () => {
    expect(isTelegramChatId("123456789")).toBe(true);
    expect(isTelegramChatId("-1001234567890")).toBe(true);
  });

  it("refuses zero, text and usernames", () => {
    for (const text of ["0", "-", "", "abc", "@group", "12 34"]) expect(isTelegramChatId(text)).toBe(false);
  });
});

describe("notifyChatOf", () => {
  it("prefers the notification chat, then the first allowed user", () => {
    expect(notifyChatOf({ notifyChatId: "-100123", allowedUserIds: [42] })).toBe(-100123);
    expect(notifyChatOf({ notifyChatId: null, allowedUserIds: [42, 7] })).toBe(42);
    expect(notifyChatOf({ notifyChatId: null, allowedUserIds: [] })).toBeNull();
  });
});

describe("telegramConversationKey", () => {
  it("keys a conversation by chat, and by topic or thread inside it", () => {
    expect(telegramConversationKey(-100, undefined)).toBe("-100");
    expect(telegramConversationKey(-100, null)).toBe("-100");
    expect(telegramConversationKey(-100, 42)).toBe("-100:42");
  });
});

import { isUserError } from "@abotica/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../platform/settings";
import {
  clearTelegramBotStatus,
  fetchTelegramBot,
  getTelegramBotStatus,
  setTelegramBotStatus,
  TELEGRAM_TOKEN_SECRET,
} from "./telegram-config";

// What the module reads and writes: the vault, the app settings, the settings rows by key and Redis.
const state = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  redis: new Map<string, string>(),
  settings: { telegramAllowedUserIds: [] as number[], telegramNotifyChatId: null as string | null },
  rows: new Map<string, unknown>(),
}));

// The marker lookup selects by key only, so `eq` hands the key to `where`, which answers from `rows`.
vi.mock("@abotica/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async (key: string) => (state.rows.has(key) ? [{ key }] : []) }) }),
    insert: () => ({
      values: (row: { key: string; value: unknown }) => ({
        onConflictDoNothing: async () => void (state.rows.has(row.key) || state.rows.set(row.key, row.value)),
      }),
    }),
  },
  settings: {},
}));
vi.mock("@abotica/db/orm", () => ({ eq: (_column: unknown, value: unknown) => value }));
vi.mock("../platform/vault", () => ({
  getSecret: async (name: string) => state.secrets.get(name),
  setSecret: async (name: string, value: string) => void state.secrets.set(name, value),
  deleteSecret: async (name: string) => state.secrets.delete(name),
}));
vi.mock("../platform/settings", () => ({
  getSettings: async () => ({ ...state.settings }),
  updateSettings: async (patch: Partial<AppSettings>) => void Object.assign(state.settings, patch),
  settingsLocale: () => "en",
}));
vi.mock("../platform/audit", () => ({ audit: async () => {} }));
vi.mock("../infra/redis", () => ({
  redis: () => ({
    get: async (key: string) => state.redis.get(key) ?? null,
    set: async (key: string, value: string) => void state.redis.set(key, value),
    del: async (key: string) => void state.redis.delete(key),
  }),
}));
vi.mock("../infra/events", () => ({ publish: async () => {} }));

beforeEach(() => {
  state.secrets.clear();
  state.redis.clear();
  state.rows.clear();
  state.settings = { telegramAllowedUserIds: [], telegramNotifyChatId: null };
});

describe("fetchTelegramBot", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The message key a call failed with. */
  const failure = (call: Promise<unknown>) =>
    call.then(
      () => undefined,
      (error: unknown) => (isUserError(error) ? error.key : error),
    );

  it("returns the bot's username", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, result: { username: "abotica_bot" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchTelegramBot("123456:secret-part")).toEqual({ username: "abotica_bot" });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("https://api.telegram.org/bot123456:secret-part/getMe");
  });

  it("refuses a malformed token without calling Telegram", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const token of ["secret-part", "123456:", "123/../456:x", "123456:abc def"]) {
      expect(await failure(fetchTelegramBot(token))).toBe("settings.telegram.errors.tokenFormat");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells a refused token from Telegram being unreachable", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }));
    expect(await failure(fetchTelegramBot("123456:revoked"))).toBe("settings.telegram.errors.tokenRefused");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await failure(fetchTelegramBot("123456:secret-part"))).toBe("settings.telegram.errors.unreachable");
  });
});

describe("getTelegramBotStatus", () => {
  const running = { state: "running", username: "abotica_bot", startedAt: "2026-10-08T10:00:00.000Z" } as const;

  it("reports the bot running with the token in the vault, without keeping the token", async () => {
    state.secrets.set(TELEGRAM_TOKEN_SECRET, "123456:current");
    await setTelegramBotStatus("123456:current", running);
    expect(await getTelegramBotStatus()).toEqual(running);
    expect([...state.redis.values()].join()).not.toContain("123456:current");
  });

  it("ignores the status of a token replaced or removed since", async () => {
    await setTelegramBotStatus("123456:old", running);
    state.secrets.set(TELEGRAM_TOKEN_SECRET, "123456:new");
    expect(await getTelegramBotStatus()).toBeNull();
    state.secrets.clear();
    expect(await getTelegramBotStatus()).toBeNull();
  });

  it("is null once the worker cleared it", async () => {
    state.secrets.set(TELEGRAM_TOKEN_SECRET, "123456:current");
    await setTelegramBotStatus("123456:current", running);
    await clearTelegramBotStatus();
    expect(await getTelegramBotStatus()).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "./settings";
import { importLegacyEnv, settingsFromEnv } from "./settings-env";

// What the import reads and writes: the stored settings, the vault and the settings rows by key.
const state = vi.hoisted(() => ({
  stored: {} as Partial<AppSettings>,
  secrets: new Map<string, string>(),
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
vi.mock("./settings", () => ({
  storedSettings: async () => ({ ...state.stored }),
  getSettings: async () => ({ ...state.stored }),
  updateSettings: async (patch: Partial<AppSettings>) => void Object.assign(state.stored, patch),
  settingsLocale: () => "en",
}));
vi.mock("./vault", () => ({ setSecret: async (name: string, value: string) => void state.secrets.set(name, value) }));
vi.mock("./audit", () => ({ audit: async () => {} }));
vi.mock("../telegram/telegram-config", () => ({
  TELEGRAM_TOKEN_SECRET: "TELEGRAM_BOT_TOKEN",
  getTelegramToken: async () => state.secrets.get("TELEGRAM_BOT_TOKEN"),
}));

beforeEach(() => {
  state.stored = {};
  state.secrets.clear();
  state.rows.clear();
});

/** The old variables are copied once, only into settings that do not have the key yet. */
describe("settingsFromEnv", () => {
  it("copies every variable the stored settings lack", () => {
    const env = { OLLAMA_BASE_URL: "http://192.168.1.20:11434/", EMBEDDING_PROVIDER: "ollama", RUN_CONCURRENCY: "6" };
    expect(settingsFromEnv({ journalDays: 5 }, env)).toEqual({
      patch: { ollamaBaseUrl: "http://192.168.1.20:11434", embeddingProvider: "ollama", runConcurrency: 6 },
      imported: ["OLLAMA_BASE_URL", "EMBEDDING_PROVIDER", "RUN_CONCURRENCY"],
    });
  });

  it("keeps what the stored settings already have, whatever the variable says", () => {
    const stored = { ollamaBaseUrl: "http://localhost:11434", embeddingProvider: "openai", runConcurrency: 4 };
    const env = { OLLAMA_BASE_URL: "http://ollama:11434", EMBEDDING_PROVIDER: "ollama", RUN_CONCURRENCY: "8" };
    expect(settingsFromEnv(stored, env)).toEqual({ patch: {}, imported: [] });
  });

  it("imports nothing from unset or empty variables", () => {
    expect(settingsFromEnv({}, { OLLAMA_BASE_URL: " ", RUN_CONCURRENCY: "" })).toEqual({ patch: {}, imported: [] });
  });

  it("stores the old compose address of the host as localhost", () => {
    const { patch } = settingsFromEnv({}, { OLLAMA_BASE_URL: "http://host.docker.internal:11434" });
    expect(patch.ollamaBaseUrl).toBe("http://localhost:11434");
  });

  it("keeps a container address as it is", () => {
    const { patch } = settingsFromEnv({}, { OLLAMA_BASE_URL: "http://ollama:11434" });
    expect(patch.ollamaBaseUrl).toBe("http://ollama:11434");
  });

  it("leaves out values it cannot read, so the defaults apply", () => {
    const env = { OLLAMA_BASE_URL: "localhost:11434", EMBEDDING_PROVIDER: "cohere", RUN_CONCURRENCY: "2.5" };
    expect(settingsFromEnv({}, env)).toEqual({ patch: {}, imported: [] });
    expect(settingsFromEnv({}, { RUN_CONCURRENCY: "0" }).imported).toEqual([]);
  });

  it("caps the run concurrency at the most Settings allows", () => {
    expect(settingsFromEnv({}, { RUN_CONCURRENCY: "64" }).patch).toEqual({ runConcurrency: 20 });
  });
});

describe("settingsFromEnv: Telegram", () => {
  it("copies the allowed users and the notification chat", () => {
    const env = { TELEGRAM_ALLOWED_USER_IDS: "111, 222", TELEGRAM_NOTIFY_CHAT_ID: "-100999" };
    expect(settingsFromEnv({}, env)).toEqual({
      patch: { telegramAllowedUserIds: [111, 222], telegramNotifyChatId: "-100999" },
      imported: ["TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_NOTIFY_CHAT_ID"],
    });
  });

  it("leaves out ids it cannot read", () => {
    const env = { TELEGRAM_ALLOWED_USER_IDS: "111, someone", TELEGRAM_NOTIFY_CHAT_ID: "@group" };
    expect(settingsFromEnv({}, env)).toEqual({ patch: {}, imported: [] });
  });
});

const OLD_ENV = {
  TELEGRAM_BOT_TOKEN: "123456:old-token",
  TELEGRAM_ALLOWED_USER_IDS: "111",
  RUN_CONCURRENCY: "6",
};

describe("importLegacyEnv", () => {
  it("copies the settings and the bot token", async () => {
    expect(await importLegacyEnv(OLD_ENV)).toEqual(["RUN_CONCURRENCY", "TELEGRAM_ALLOWED_USER_IDS", "TELEGRAM_BOT_TOKEN"]);
    expect(state.stored).toEqual({ runConcurrency: 6, telegramAllowedUserIds: [111] });
    expect(state.secrets.get("TELEGRAM_BOT_TOKEN")).toBe("123456:old-token");
  });

  it("never overwrites what was set in Settings", async () => {
    state.stored = { runConcurrency: 2, telegramAllowedUserIds: [] };
    state.secrets.set("TELEGRAM_BOT_TOKEN", "123456:from-settings");
    expect(await importLegacyEnv(OLD_ENV)).toEqual([]);
    expect(state.stored).toEqual({ runConcurrency: 2, telegramAllowedUserIds: [] });
    expect(state.secrets.get("TELEGRAM_BOT_TOKEN")).toBe("123456:from-settings");
  });

  it("imports once: what is removed in Settings later stays removed", async () => {
    await importLegacyEnv(OLD_ENV);
    state.secrets.clear();
    state.stored = {};
    expect(await importLegacyEnv(OLD_ENV)).toEqual([]);
    expect(state.secrets.size).toBe(0);
    expect(state.stored).toEqual({});
  });
});

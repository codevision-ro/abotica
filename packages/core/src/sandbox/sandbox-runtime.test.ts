import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type SandboxSettings } from "../settings/settings-schema";

const DAY_MS = 86_400_000;
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const KEY = `conversation-${CONVERSATION}`;

// What the reaper reads: the settings, a backend with one conversation workspace, the conversation's row.
const state = vi.hoisted(() => ({
  sandbox: {} as SandboxSettings,
  lastUsedAt: new Date(),
  reap: vi.fn<(options: { pauseAfterMs: number; stopAfterMs: number }) => Promise<void>>(async () => {}),
  remove: vi.fn<(key: string) => Promise<void>>(async () => {}),
}));

vi.mock("@abotica/sandbox", () => ({
  createBackend: async () => ({
    backend: {
      reap: state.reap,
      remove: state.remove,
      list: async () => [{ key: KEY, lastUsedAt: state.lastUsedAt }],
      close: async () => {},
    },
    status: { enabled: true, isolation: "runc", docker: {} },
  }),
}));
vi.mock("../settings/settings", () => ({ getSettings: async () => ({ sandbox: state.sandbox }) }));
vi.mock("@abotica/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ id: CONVERSATION }] }) }) },
  conversations: { id: "id" },
  projects: { id: "id" },
  mcpServers: {},
}));
vi.mock("../infra/redis", () => ({
  redis: () => ({
    set: async () => "OK",
    hgetall: async () => ({}),
    hdel: async () => 0,
    hset: async () => 1,
    smembers: async () => [],
    srem: async () => 0,
  }),
}));
vi.mock("../infra/events", () => ({ publish: async () => {} }));
vi.mock("../infra/env", () => ({ env: () => ({ SANDBOX_DOCKER_HOST: undefined }) }));

const { idleTimings, initSandbox, reapSandbox } = await import("./sandbox-runtime");

beforeEach(() => {
  state.sandbox = DEFAULT_SETTINGS.sandbox;
  state.reap.mockClear();
  state.remove.mockClear();
});

describe("idleTimings", () => {
  it("turns the sandbox settings into the reaper's times", () => {
    expect(idleTimings(DEFAULT_SETTINGS.sandbox)).toEqual({
      pauseAfterMs: 15 * 60_000,
      stopAfterMs: 6 * 3600_000,
      conversationTtlMs: 30 * DAY_MS,
    });
  });
});

describe("reapSandbox", () => {
  it("pauses, stops and deletes after the times in the settings", async () => {
    await initSandbox();
    state.sandbox = { ...DEFAULT_SETTINGS.sandbox, pauseIdleMinutes: 5, stopIdleHours: 2, workspaceRetentionDays: 3 };
    state.lastUsedAt = new Date(Date.now() - 2 * DAY_MS);
    await reapSandbox();
    expect(state.reap).toHaveBeenCalledWith({ pauseAfterMs: 5 * 60_000, stopAfterMs: 2 * 3600_000 });
    expect(state.remove).not.toHaveBeenCalled();

    state.lastUsedAt = new Date(Date.now() - 4 * DAY_MS);
    await reapSandbox();
    expect(state.remove).toHaveBeenCalledWith(KEY);
  });
});

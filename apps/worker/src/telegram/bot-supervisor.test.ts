import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBotSupervisor } from "./bot-supervisor";

/** A bot that polls until stopped, like grammY's after `start`. */
class FakeBot {
  running = true;
  constructor(readonly token: string) {}
  isRunning() {
    return this.running;
  }
  async stop() {
    this.running = false;
  }
}

let token: string | undefined;
let launched: FakeBot[];
let missing: boolean[];

function supervisor() {
  return createBotSupervisor<FakeBot>({
    readToken: async () => token,
    launch: (t) => {
      const bot = new FakeBot(t);
      launched.push(bot);
      return bot;
    },
    onMissing: async (stopped) => void missing.push(stopped),
  });
}

beforeEach(() => {
  token = undefined;
  launched = [];
  missing = [];
});

describe("createBotSupervisor", () => {
  it("starts without a bot when no token is set", async () => {
    const s = supervisor();
    await s.reload();
    expect(s.bot()).toBeNull();
    expect(missing).toEqual([false]);
  });

  it("starts the bot when a token is saved, and keeps it while the token is the same", async () => {
    const s = supervisor();
    await s.reload();
    token = "1:a";
    await s.reload();
    await s.reload();
    expect(launched.map((b) => b.token)).toEqual(["1:a"]);
    expect(s.bot()).toBe(launched[0]);
  });

  it("restarts the bot with a new token, stopping the old one first", async () => {
    token = "1:a";
    const s = supervisor();
    await s.reload();
    token = "1:b";
    await s.reload();
    expect(launched.map((b) => [b.token, b.running])).toEqual([
      ["1:a", false],
      ["1:b", true],
    ]);
    expect(s.owns(launched[0]!)).toBe(false);
    expect(s.owns(launched[1]!)).toBe(true);
  });

  it("stops the bot when the token is removed", async () => {
    token = "1:a";
    const s = supervisor();
    await s.reload();
    token = undefined;
    await s.reload();
    expect(launched[0]!.running).toBe(false);
    expect(s.bot()).toBeNull();
    expect(missing).toEqual([true]);
  });

  it("starts again a bot that stopped polling on its own", async () => {
    token = "1:a";
    const s = supervisor();
    await s.reload();
    launched[0]!.running = false;
    await s.reload();
    expect(launched).toHaveLength(2);
    expect(s.bot()).toBe(launched[1]);
  });

  it("runs reloads one after another, so quick saves never leave two bots polling", async () => {
    const s = supervisor();
    token = "1:a";
    const first = s.reload();
    token = "1:b";
    await Promise.all([first, s.reload()]);
    expect(launched.filter((b) => b.running).map((b) => b.token)).toEqual(["1:b"]);
  });

  it("keeps the bot for sending after close, and ignores later reloads", async () => {
    token = "1:a";
    const s = supervisor();
    await s.reload();
    await s.close();
    token = "1:b";
    await s.reload();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.running).toBe(false);
    expect(s.bot()).toBe(launched[0]);
    expect(s.owns(launched[0]!)).toBe(false);
  });

  it("survives a token that cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = createBotSupervisor<FakeBot>({
      readToken: async () => {
        throw new Error("database down");
      },
      launch: (t) => new FakeBot(t),
      onMissing: async () => {},
    });
    await s.reload();
    expect(s.bot()).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

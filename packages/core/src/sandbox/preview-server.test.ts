import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Preview } from "./previews";

/**
 * Live previews of a workspace that may be paused. The sandbox backend is a fake whose `wake`
 * answers with the address of an app this test runs on localhost; the preview comes from a mocked
 * lookup, everything else (routing, proxying, the error pages) is real.
 */

const sandbox = vi.hoisted(() => ({ wake: vi.fn<(key: string) => Promise<string | null>>() }));
const live = vi.hoisted(() => ({ preview: null as Preview | null }));

vi.mock("./sandbox-runtime", () => ({ currentSandboxBackend: () => sandbox }));
vi.mock("./sandbox", () => ({ touchWorkspace: async () => {} }));
vi.mock("./previews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./previews")>()),
  previewByHost: async () => live.preview,
}));
vi.mock("../settings/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings/settings")>()),
  getSettings: async () => ({}),
  settingsLocale: () => "en",
}));

const HOST = "abcdefghijklmnopqrstuvwxyz";
const KEY = "project-11111111-2222-4333-8444-555555555555";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let previewPort: number;
let previewServer: { close(): Promise<void> };
let app: http.Server | null = null;

/** Starts the app behind the preview after `delayMs`, like one whose workspace was just unpaused. */
function startAppAfter(delayMs: number) {
  setTimeout(() => {
    app = http.createServer((_req, res) => res.end("hello from the app"));
    app.listen(live.preview!.port!, "127.0.0.1");
  }, delayMs);
}

function get(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: previewPort, path: "/", headers: { host: `${HOST}.preview.localhost` } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  previewPort = await freePort();
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  vi.stubEnv("VAULT_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("PREVIEW_URL", "http://preview.localhost:3100");
  vi.stubEnv("PREVIEW_PORT", String(previewPort));
  live.preview = { host: HOST, kind: "live", public: true, workspaceKey: KEY, port: await freePort() } as Preview;
  const { startPreviewServer } = await import("./preview-server");
  previewServer = await startPreviewServer();
});

afterEach(async () => {
  sandbox.wake.mockReset();
  await new Promise((resolve) => (app ? app.close(resolve) : resolve(undefined)));
  app = null;
});

afterAll(async () => {
  await previewServer.close();
  vi.unstubAllEnvs();
});

describe("live previews", () => {
  it("wake the workspace and wait for its app to accept connections", async () => {
    sandbox.wake.mockResolvedValue("127.0.0.1");
    startAppAfter(300);
    expect(await get()).toEqual({ status: 200, body: "hello from the app" });
    expect(sandbox.wake).toHaveBeenCalledWith(KEY);
  });

  it("answer that the app is not running when the workspace is stopped", async () => {
    sandbox.wake.mockResolvedValue(null);
    const { status, body } = await get();
    expect(status).toBe(502);
    expect(body).toContain("The app is not running");
  });

  it("give up after about 2 s when nothing listens on the port", async () => {
    sandbox.wake.mockResolvedValue("127.0.0.1");
    const started = Date.now();
    expect((await get()).status).toBe(502);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Access values are signed with a key derived from VAULT_KEY; PREVIEW_URL decides hosts and cookies. */
async function load(previewUrl: string) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgres://test@localhost/test");
  vi.stubEnv("VAULT_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("PREVIEW_URL", previewUrl);
  return import("./previews");
}

const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const HOST = "abcdefghijklmnopqrstuvwxyz";

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllEnvs());

describe("preview addresses", () => {
  it("puts each preview on its own subdomain", async () => {
    const { previewUrl, previewHostOf } = await load("https://preview.example.com");
    expect(previewUrl({ host: HOST })).toBe(`https://${HOST}.preview.example.com/`);
    expect(previewUrl({ host: HOST }, "/a?b=1")).toBe(`https://${HOST}.preview.example.com/a?b=1`);
    expect(previewHostOf(`${HOST}.preview.example.com`)).toBe(HOST);
    expect(previewHostOf(`${HOST.toUpperCase()}.Preview.Example.com`)).toBe(HOST);
  });

  it("names no preview for other hosts", async () => {
    const { previewHostOf } = await load("http://preview.localhost:3100");
    expect(previewHostOf(`${HOST}.preview.localhost:3100`)).toBe(HOST);
    // The reverse proxy asks about certificates by name only.
    expect(previewHostOf(`${HOST}.preview.localhost`)).toBe(HOST);
    expect(previewHostOf("preview.localhost:3100")).toBeNull();
    expect(previewHostOf(`${HOST}.preview.other.localhost:3100`)).toBeNull();
    expect(previewHostOf(`x.${HOST}.preview.localhost:3100`)).toBeNull();
    expect(previewHostOf(`short.preview.localhost:3100`)).toBeNull();
    expect(previewHostOf(undefined)).toBeNull();
  });

  it("uses a __Host- cookie over HTTPS only", async () => {
    expect((await load("https://preview.example.com")).previewCookieName()).toBe("__Host-abotica_preview");
    expect((await load("http://preview.localhost:3100")).previewCookieName()).toBe("abotica_preview");
  });
});

describe("preview cookies", () => {
  it("grant the preview they were made for, until it expires", async () => {
    const { previewCookie, validPreviewCookie } = await load("https://preview.example.com");
    const now = Date.now();
    const cookie = previewCookie({ id: ID, expiresAt: new Date(now + 3600_000) }, now);
    expect(cookie.maxAgeSeconds).toBe(3600);
    expect(validPreviewCookie(cookie.value, ID, now)).toBe(true);
    expect(validPreviewCookie(cookie.value, OTHER, now)).toBe(false);
    expect(validPreviewCookie(cookie.value, ID, now + 3600_001)).toBe(false);
  });

  it("last at most a day, even for a preview that lives longer", async () => {
    const { previewCookie } = await load("https://preview.example.com");
    const now = Date.now();
    expect(previewCookie({ id: ID, expiresAt: new Date(now + 7 * 86_400_000) }, now).maxAgeSeconds).toBe(86_400);
  });

  it("refuse anything not signed by this server", async () => {
    const { previewCookie, validPreviewCookie } = await load("https://preview.example.com");
    const now = Date.now();
    const { value } = previewCookie({ id: ID, expiresAt: new Date(now + 3600_000) }, now);
    const [id, expires, signature] = value.split(".");
    expect(validPreviewCookie(`${id}.${Number(expires) + 1000}.${signature}`, ID, now)).toBe(false);
    expect(validPreviewCookie(`${id}.${expires}.${signature!.slice(0, -2)}xx`, ID, now)).toBe(false);
    expect(validPreviewCookie(`${id}.${expires}`, ID, now)).toBe(false);
    expect(validPreviewCookie(undefined, ID, now)).toBe(false);
  });
});

describe("preview lifetime", () => {
  it("follows the preview settings: hours for a live link, days for a static copy", async () => {
    const { previewTtlMs } = await load("https://preview.example.com");
    expect(previewTtlMs("live", { liveHours: 24, staticDays: 7 })).toBe(24 * 3600_000);
    expect(previewTtlMs("static", { liveHours: 24, staticDays: 7 })).toBe(7 * 86_400_000);
    expect(previewTtlMs("live", { liveHours: 2, staticDays: 30 })).toBe(2 * 3600_000);
    expect(previewTtlMs("static", { liveHours: 2, staticDays: 30 })).toBe(30 * 86_400_000);
  });
});

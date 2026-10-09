import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_RATE_LIMIT,
  WEBHOOK_RATE_LIMIT_BOUNDS,
  WEBHOOK_REFUSED_LIMIT,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from "./trigger-events";

/** Enough of Redis for these checks: the rate script's INCR and EXPIRE, SET NX with a TTL, DEL. */
const store = new Map<string, { value: number; ttl: number }>();
const fakeRedis = {
  eval: async (_script: string, _keys: number, key: string, windowSeconds: number) => {
    const entry = store.get(key) ?? { value: 0, ttl: windowSeconds };
    entry.value += 1;
    store.set(key, entry);
    return [entry.value, entry.ttl];
  },
  set: async (key: string, _value: string, _ex: "EX", ttl: number) => {
    if (store.has(key)) return null;
    store.set(key, { value: 1, ttl });
    return "OK";
  },
  del: async (key: string) => Number(store.delete(key)),
};

vi.mock("../infra/redis", () => ({ redis: () => fakeRedis }));
// The stored secret is the plain one here; encryption has tests of its own.
vi.mock("../platform/vault", () => ({ decrypt: (value: string) => value }));

const { takeRefusedWebhookRequest, takeWebhookRequest, verifyWebhookRequest } = await import("./webhooks");
const { newSigningSecret } = await import("./webhook-signature");

const TRIGGER_ID = "11111111-2222-4333-8444-555555555555";
const TRIGGER = { id: TRIGGER_ID, rateLimitPerMinute: null };

beforeEach(() => store.clear());

describe("webhook rate limit", () => {
  it("allows the limit, then refuses with the time left in the window", async () => {
    for (let i = 0; i < WEBHOOK_RATE_LIMIT.requests; i++) {
      expect(await takeWebhookRequest(TRIGGER)).toEqual({ allowed: true });
    }
    expect(await takeWebhookRequest(TRIGGER)).toEqual({
      allowed: false,
      retryAfter: WEBHOOK_RATE_LIMIT.windowSeconds,
      firstRefusal: true,
    });
    expect(await takeWebhookRequest(TRIGGER)).toMatchObject({ allowed: false, firstRefusal: false });
  });

  it("uses the trigger's own limit when it sets one", async () => {
    const own = { ...TRIGGER, rateLimitPerMinute: 3 };
    for (let i = 0; i < 3; i++) expect(await takeWebhookRequest(own)).toEqual({ allowed: true });
    expect(await takeWebhookRequest(own)).toEqual({
      allowed: false,
      retryAfter: WEBHOOK_RATE_LIMIT.windowSeconds,
      firstRefusal: true,
    });
  });

  it("counts each trigger on its own", async () => {
    for (let i = 0; i <= WEBHOOK_RATE_LIMIT.requests; i++) await takeWebhookRequest(TRIGGER);
    expect(await takeWebhookRequest({ ...TRIGGER, id: "99999999-2222-4333-8444-555555555555" })).toEqual({ allowed: true });
  });
});

describe("refused webhook requests", () => {
  it("have a higher limit of their own, so failed requests do not use up the run limit", async () => {
    expect(WEBHOOK_REFUSED_LIMIT.requests).toBeGreaterThan(WEBHOOK_RATE_LIMIT.requests);
    expect(WEBHOOK_REFUSED_LIMIT.requests).toBeGreaterThan(WEBHOOK_RATE_LIMIT_BOUNDS.max);
    for (let i = 0; i < WEBHOOK_REFUSED_LIMIT.requests; i++) {
      expect(await takeRefusedWebhookRequest(TRIGGER_ID)).toEqual({ allowed: true });
    }
    expect(await takeRefusedWebhookRequest(TRIGGER_ID)).toEqual({
      allowed: false,
      retryAfter: WEBHOOK_REFUSED_LIMIT.windowSeconds,
      firstRefusal: true,
    });
    expect(await takeRefusedWebhookRequest(TRIGGER_ID)).toMatchObject({ allowed: false, firstRefusal: false });
    expect(await takeWebhookRequest(TRIGGER)).toEqual({ allowed: true });
  });

  it("are not limited by a full run limit", async () => {
    for (let i = 0; i <= WEBHOOK_RATE_LIMIT.requests; i++) await takeWebhookRequest(TRIGGER);
    expect(await takeRefusedWebhookRequest(TRIGGER_ID)).toEqual({ allowed: true });
  });
});

describe("webhook request verification", () => {
  const secret = newSigningSecret();
  const trigger = { id: TRIGGER_ID, signingSecret: secret };
  const body = Buffer.from('{"event":"order.created"}');

  function signed(id: string, timestamp = Math.floor(Date.now() / 1000)) {
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const mac = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
    return new Headers({ "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${mac}` });
  }

  it("accepts anything when the trigger has no signing secret", async () => {
    const check = await verifyWebhookRequest({ id: TRIGGER_ID, signingSecret: null }, new Headers(), body);
    expect(check.ok).toBe(true);
  });

  it("refuses unsigned and badly signed requests when it has one", async () => {
    expect(await verifyWebhookRequest(trigger, new Headers(), body)).toEqual({ ok: false, reason: "missing-signature" });
    expect(await verifyWebhookRequest(trigger, signed("msg_1"), Buffer.from("{}"))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyWebhookRequest(trigger, signed("msg_2", 1_000_000_000), body)).toEqual({
      ok: false,
      reason: "expired-timestamp",
    });
  });

  it("accepts a message id once", async () => {
    const headers = signed("msg_once");
    expect((await verifyWebhookRequest(trigger, headers, body)).ok).toBe(true);
    expect(await verifyWebhookRequest(trigger, headers, body)).toEqual({ ok: false, reason: "replayed" });
    // The same id for another trigger is another message.
    expect((await verifyWebhookRequest({ ...trigger, id: "other" }, headers, body)).ok).toBe(true);
  });

  it("remembers the id for the whole time its timestamp is accepted", async () => {
    await verifyWebhookRequest(trigger, signed("msg_ttl"), body);
    expect(store.get(`abotica:webhook:seen:${TRIGGER_ID}:msg_ttl`)?.ttl).toBe(2 * WEBHOOK_SIGNATURE_TOLERANCE_SECONDS);
  });

  it("lets the sender retry after a release", async () => {
    const headers = signed("msg_retry");
    const first = await verifyWebhookRequest(trigger, headers, body);
    if (!first.ok) throw new Error("expected the first delivery to pass");
    await first.release();
    expect((await verifyWebhookRequest(trigger, headers, body)).ok).toBe(true);
  });

  it("accepts GitHub signatures, which carry no message id", async () => {
    const headers = new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    });
    expect((await verifyWebhookRequest(trigger, headers, body)).ok).toBe(true);
    expect((await verifyWebhookRequest(trigger, headers, body)).ok).toBe(true);
  });
});

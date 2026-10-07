import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "./trigger-events";
import {
  newSigningSecret,
  verifyGitHubSignature,
  verifyStandardWebhook,
  verifyWebhookSignature,
} from "./webhook-signature";

/** Test vector from the Standard Webhooks specification. */
const STANDARD = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: Buffer.from('{"test": 2432232314}'),
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

/** Test vector from GitHub's webhook documentation. */
const GITHUB = {
  secret: "It's a Secret to Everybody",
  body: Buffer.from("Hello, World!"),
  signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
};

const standardHeaders = (signature = STANDARD.signature, timestamp = STANDARD.timestamp) =>
  new Headers({ "webhook-id": STANDARD.id, "webhook-timestamp": String(timestamp), "webhook-signature": signature });

/** Signs like a Standard Webhooks sender would, for a secret made here. */
function signStandard(secret: string, id: string, timestamp: number, body: Buffer) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
  return `v1,${mac}`;
}

describe("Standard Webhooks signatures", () => {
  const now = STANDARD.timestamp;

  it("accepts the specification's example", () => {
    expect(verifyStandardWebhook(STANDARD.secret, standardHeaders(), STANDARD.body, now)).toEqual({
      ok: true,
      scheme: "standard-webhooks",
      messageId: STANDARD.id,
    });
  });

  it("accepts a request signed with a generated secret", () => {
    const secret = newSigningSecret();
    const body = Buffer.from(JSON.stringify({ order: 42, note: "café ✓" }));
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(now),
      "webhook-signature": signStandard(secret, "msg_1", now, body),
    });
    expect(verifyStandardWebhook(secret, headers, body, now).ok).toBe(true);
  });

  it("refuses a wrong secret", () => {
    const check = verifyStandardWebhook(newSigningSecret(), standardHeaders(), STANDARD.body, now);
    expect(check).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a tampered body, id or timestamp", () => {
    const tampered = Buffer.from('{"test": 2432232315}');
    expect(verifyStandardWebhook(STANDARD.secret, standardHeaders(), tampered, now).ok).toBe(false);

    const otherId = standardHeaders();
    otherId.set("webhook-id", "msg_other");
    expect(verifyStandardWebhook(STANDARD.secret, otherId, STANDARD.body, now).ok).toBe(false);

    const later = standardHeaders(STANDARD.signature, now + 1);
    expect(verifyStandardWebhook(STANDARD.secret, later, STANDARD.body, now).ok).toBe(false);
  });

  it("verifies the raw bytes, not a re-encoded body", () => {
    const body = Buffer.from('{"b":1,  "a":2}');
    const secret = newSigningSecret();
    const headers = new Headers({
      "webhook-id": "msg_raw",
      "webhook-timestamp": String(now),
      "webhook-signature": signStandard(secret, "msg_raw", now, body),
    });
    const reencoded = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(verifyStandardWebhook(secret, headers, body, now).ok).toBe(true);
    expect(verifyStandardWebhook(secret, headers, reencoded, now).ok).toBe(false);
  });

  it("refuses timestamps outside the tolerance, in both directions", () => {
    const tolerance = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    const verify = (at: number) => verifyStandardWebhook(STANDARD.secret, standardHeaders(), STANDARD.body, at);
    expect(verify(now + tolerance).ok).toBe(true);
    expect(verify(now - tolerance).ok).toBe(true);
    expect(verify(now + tolerance + 1)).toEqual({ ok: false, reason: "expired-timestamp" });
    expect(verify(now - tolerance - 1)).toEqual({ ok: false, reason: "expired-timestamp" });
  });

  it("refuses a timestamp that is not a number of seconds", () => {
    const headers = standardHeaders();
    headers.set("webhook-timestamp", "2021-02-25T15:02:10Z");
    expect(verifyStandardWebhook(STANDARD.secret, headers, STANDARD.body, now)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("accepts any matching v1 signature among several", () => {
    const other = "v1,Ym9ndXNib2d1c2JvZ3VzYm9ndXNib2d1c2JvZ3VzYm8=";
    const headers = standardHeaders(`v1a,c29tZXRoaW5n ${other} ${STANDARD.signature}`);
    expect(verifyStandardWebhook(STANDARD.secret, headers, STANDARD.body, now).ok).toBe(true);
    expect(verifyStandardWebhook(STANDARD.secret, standardHeaders(other), STANDARD.body, now).ok).toBe(false);
  });

  it("ignores signatures of other versions or in other encodings", () => {
    const mac = STANDARD.signature.slice("v1,".length);
    const hex = Buffer.from(mac, "base64").toString("hex");
    for (const signature of [`v2,${mac}`, `v1a,${mac}`, mac, `v1,${hex}`, "v1,", "v1"]) {
      expect(verifyStandardWebhook(STANDARD.secret, standardHeaders(signature), STANDARD.body, now).ok).toBe(false);
    }
  });

  it("reports missing headers", () => {
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers = standardHeaders();
      headers.delete(name);
      expect(verifyStandardWebhook(STANDARD.secret, headers, STANDARD.body, now)).toEqual({
        ok: false,
        reason: "missing-signature",
      });
    }
  });
});

describe("GitHub signatures", () => {
  const headers = (signature: string) => new Headers({ "x-hub-signature-256": signature });

  it("accepts GitHub's documented example", () => {
    expect(verifyGitHubSignature(GITHUB.secret, headers(GITHUB.signature), GITHUB.body)).toEqual({
      ok: true,
      scheme: "github",
      messageId: null,
    });
  });

  it("keys the HMAC with the secret string as GitHub does", () => {
    const secret = newSigningSecret();
    const signature = `sha256=${createHmac("sha256", secret).update(GITHUB.body).digest("hex")}`;
    expect(verifyGitHubSignature(secret, headers(signature), GITHUB.body).ok).toBe(true);
  });

  it("refuses a wrong secret or a tampered body", () => {
    expect(verifyGitHubSignature("another secret", headers(GITHUB.signature), GITHUB.body)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifyGitHubSignature(GITHUB.secret, headers(GITHUB.signature), Buffer.from("Hello, World?")).ok).toBe(false);
  });

  it("refuses malformed headers", () => {
    const hex = GITHUB.signature.slice("sha256=".length);
    for (const signature of [
      hex,
      `sha1=${hex}`,
      `sha256=${hex.slice(2)}`,
      `sha256=${hex}00`,
      `sha256=${"zz".repeat(32)}`,
    ]) {
      expect(verifyGitHubSignature(GITHUB.secret, headers(signature), GITHUB.body)).toEqual({
        ok: false,
        reason: "bad-signature",
      });
    }
  });

  it("reports a missing header", () => {
    expect(verifyGitHubSignature(GITHUB.secret, new Headers(), GITHUB.body)).toEqual({
      ok: false,
      reason: "missing-signature",
    });
  });
});

describe("scheme selection", () => {
  it("uses Standard Webhooks when its signature header is present", () => {
    const headers = standardHeaders();
    headers.set("x-hub-signature-256", GITHUB.signature);
    expect(verifyWebhookSignature(STANDARD.secret, headers, STANDARD.body, STANDARD.timestamp)).toMatchObject({
      ok: true,
      scheme: "standard-webhooks",
    });
    // A bad Standard Webhooks signature is not rescued by a GitHub header.
    expect(verifyWebhookSignature(GITHUB.secret, headers, GITHUB.body, STANDARD.timestamp).ok).toBe(false);
  });

  it("falls back to GitHub, and refuses an unsigned request", () => {
    const github = new Headers({ "x-hub-signature-256": GITHUB.signature });
    expect(verifyWebhookSignature(GITHUB.secret, github, GITHUB.body)).toMatchObject({ ok: true, scheme: "github" });
    expect(verifyWebhookSignature(GITHUB.secret, new Headers(), GITHUB.body)).toEqual({
      ok: false,
      reason: "missing-signature",
    });
  });
});

describe("signing secrets", () => {
  it("are new each time, in the Standard Webhooks format with 32 random bytes", () => {
    const a = newSigningSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(a.slice("whsec_".length), "base64")).toHaveLength(32);
    expect(newSigningSecret()).not.toBe(a);
  });
});

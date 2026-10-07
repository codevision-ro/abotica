import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "./trigger-events";

/**
 * Signed webhook requests, two schemes:
 * - Standard Webhooks (standardwebhooks.com): `webhook-id`, `webhook-timestamp` (Unix seconds) and
 *   `webhook-signature`, a space-separated list of `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`.
 *   The key is the base64 part of the `whsec_` secret, decoded, as the scheme's libraries use it.
 * - GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`, keyed with the whole
 *   secret string as pasted into GitHub's webhook settings.
 * Pure, so it is tested without Redis or the database.
 */

const SECRET_PREFIX = "whsec_";

/** A new signing secret in the Standard Webhooks format: `whsec_` and 32 random bytes in base64. */
export const newSigningSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;

export type SignatureFailure = "missing-signature" | "bad-signature" | "expired-timestamp";

export type SignatureCheck =
  /** `messageId` is the Standard Webhooks `webhook-id`, to refuse replays; null for GitHub. */
  { ok: true; scheme: "standard-webhooks" | "github"; messageId: string | null } | { ok: false; reason: SignatureFailure };

type HeaderReader = Pick<Headers, "get">;

const hmac = (key: Buffer | string, ...parts: (string | Buffer)[]) => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

/** Constant-time comparison; the length of a digest is not secret. */
const sameDigest = (expected: Buffer, received: Buffer) =>
  expected.length === received.length && timingSafeEqual(expected, received);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function standardKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
}

/** Verifies a Standard Webhooks request; any `v1` signature in the header may match. */
export function verifyStandardWebhook(
  secret: string,
  headers: HeaderReader,
  body: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureCheck {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "missing-signature" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad-signature" };
  if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired-timestamp" };
  }

  const expected = hmac(standardKey(secret), `${id}.${timestamp}.`, body);
  const matches = signatures
    .split(" ")
    .map((entry) => entry.split(","))
    .some(
      ([version, signature]) =>
        version === "v1" && !!signature && BASE64.test(signature) && sameDigest(expected, Buffer.from(signature, "base64")),
    );
  return matches ? { ok: true, scheme: "standard-webhooks", messageId: id } : { ok: false, reason: "bad-signature" };
}

/** Verifies GitHub's `X-Hub-Signature-256` header. */
export function verifyGitHubSignature(secret: string, headers: HeaderReader, body: Buffer): SignatureCheck {
  const header = headers.get("x-hub-signature-256");
  if (!header) return { ok: false, reason: "missing-signature" };
  const hex = header.startsWith("sha256=") ? header.slice("sha256=".length) : "";
  if (!HEX_SHA256.test(hex)) return { ok: false, reason: "bad-signature" };
  return sameDigest(hmac(secret, body), Buffer.from(hex, "hex"))
    ? { ok: true, scheme: "github", messageId: null }
    : { ok: false, reason: "bad-signature" };
}

/**
 * Verifies a request against a trigger's signing secret with the scheme its headers use: Standard
 * Webhooks when `webhook-signature` is present, otherwise GitHub. `body` must be the raw bytes as received.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: HeaderReader,
  body: Buffer,
  nowSeconds?: number,
): SignatureCheck {
  return headers.get("webhook-signature") !== null
    ? verifyStandardWebhook(secret, headers, body, nowSeconds)
    : verifyGitHubSignature(secret, headers, body);
}

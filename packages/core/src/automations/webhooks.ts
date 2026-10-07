import { redis } from "../infra/redis";
import { WEBHOOK_RATE_LIMIT, WEBHOOK_REFUSED_LIMIT, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "./trigger-events";
import type { Trigger } from "./triggers";
import { decrypt } from "../platform/vault";
import { type SignatureFailure, verifyWebhookSignature } from "./webhook-signature";

const RATE_KEY = "abotica:webhook:rate:";
const REFUSED_KEY = "abotica:webhook:refused:";
const SEEN_KEY = "abotica:webhook:seen:";

/**
 * A timestamp is accepted up to the tolerance in either direction, so a message stays valid for
 * twice the tolerance at most; its id is remembered that long.
 */
const SEEN_TTL_SECONDS = 2 * WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;

/** INCR and the expiry of a new window in one step, so no counter is left without one. */
const RATE_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return {count, redis.call("TTL", KEYS[1])}`;

export type WebhookRate =
  | { allowed: true }
  /**
   * `retryAfter` in seconds; `firstRefusal` marks the first refused request of the window, so a
   * flood is audited once instead of once per request.
   */
  | { allowed: false; retryAfter: number; firstRefusal: boolean };

async function take(key: string, { requests, windowSeconds }: { requests: number; windowSeconds: number }) {
  const [count, ttl] = (await redis().eval(RATE_SCRIPT, 1, key, windowSeconds)) as [number, number];
  if (count <= requests) return { allowed: true } as const;
  return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds, firstRefusal: count === requests + 1 } as const;
}

/**
 * Counts a request against the trigger's run limit. A trigger without a signing secret counts every
 * request; one with a secret counts only verified ones, so requests forged by someone who has just
 * the URL cannot use up the real sender's quota.
 */
export function takeWebhookRequest(triggerId: string): Promise<WebhookRate> {
  return take(`${RATE_KEY}${triggerId}`, WEBHOOK_RATE_LIMIT);
}

/**
 * Counts a request that failed verification. Over the limit it is answered with 429 instead of
 * being logged one by one; verified requests are still checked and accepted meanwhile.
 */
export function takeRefusedWebhookRequest(triggerId: string): Promise<WebhookRate> {
  return take(`${REFUSED_KEY}${triggerId}`, WEBHOOK_REFUSED_LIMIT);
}

export type WebhookVerification =
  /** `release` forgets the message id again, so the sender can retry when no run was started. */
  { ok: true; release: () => Promise<void> } | { ok: false; reason: SignatureFailure | "replayed" };

const accepted: WebhookVerification = { ok: true, release: async () => {} };

/**
 * Checks a request against the trigger's signing secret; triggers without one accept any request.
 * A Standard Webhooks message id is accepted once per trigger, GitHub signatures carry no id or
 * timestamp to check. `body` must be the raw bytes as received.
 */
export async function verifyWebhookRequest(
  trigger: Pick<Trigger, "id" | "signingSecret">,
  headers: Pick<Headers, "get">,
  body: Buffer,
): Promise<WebhookVerification> {
  if (!trigger.signingSecret) return accepted;
  const check = verifyWebhookSignature(decrypt(trigger.signingSecret), headers, body);
  if (!check.ok) return check;
  if (!check.messageId) return accepted;

  const key = `${SEEN_KEY}${trigger.id}:${check.messageId}`;
  const fresh = await redis().set(key, "1", "EX", SEEN_TTL_SECONDS, "NX");
  if (fresh !== "OK") return { ok: false, reason: "replayed" };
  return {
    ok: true,
    release: async () => {
      await redis().del(key);
    },
  };
}

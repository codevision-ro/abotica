import {
  AgentNotOnTeamError,
  audit,
  fireTrigger,
  type Run,
  takeRefusedWebhookRequest,
  takeWebhookRequest,
  type Trigger,
  verifyWebhookRequest,
  type WebhookRate,
} from "@abotica/core";
import { getWebhookTrigger } from "@/server/queries/automations";
import { getKillSwitchState } from "@/server/queries/settings";

const MAX_MB = 1;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const json = (body: unknown, status: number, headers?: HeadersInit) => Response.json(body, { status, headers });

export async function GET() {
  return json({ error: "Method not allowed. Send the event with POST." }, 405);
}

/** The body's bytes exactly as sent, which signatures are computed over; null when over the limit. */
async function readBody(req: Request): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function prettyPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const tooMany = (rate: Extract<WebhookRate, { allowed: false }>) =>
  json({ error: "Too many requests" }, 429, { "Retry-After": String(rate.retryAfter) });

async function refused(trigger: Trigger, reason: string) {
  await audit({
    actor: "webhook",
    action: "webhook.refused",
    entityType: "trigger",
    entityId: trigger.id,
    data: { reason },
  });
}

/** Counts the request against the trigger's run limit; the 429 response when it is over. */
async function overRunLimit(trigger: Trigger): Promise<Response | null> {
  const rate = await takeWebhookRequest(trigger);
  if (rate.allowed) return null;
  if (rate.firstRefusal) await refused(trigger, "rate-limited");
  return tooMany(rate);
}

export async function POST(req: Request, ctx: RouteContext<"/api/webhooks/[token]">) {
  const { token } = await ctx.params;
  const trigger = await getWebhookTrigger(token);
  if (!trigger) return json({ error: "Webhook not found or disabled" }, 404);

  if (await getKillSwitchState()) {
    await refused(trigger, "kill-switch");
    return json({ error: "Kill switch is on: runs are stopped" }, 503);
  }

  // Without a signing secret every request counts against the run limit, before the body is read;
  // with one only verified requests do, so forged requests cannot block the real sender.
  if (!trigger.signingSecret) {
    const limited = await overRunLimit(trigger);
    if (limited) return limited;
  }

  const raw = await readBody(req);
  if (raw === null) return json({ error: `Payload too large (max ${MAX_MB} MB)` }, 413);

  const verification = await verifyWebhookRequest(trigger, req.headers, raw);
  if (!verification.ok) {
    const flood = await takeRefusedWebhookRequest(trigger.id);
    if (!flood.allowed) {
      if (flood.firstRefusal) await refused(trigger, "too-many-refused");
      return tooMany(flood);
    }
    await refused(trigger, verification.reason);
    return verification.reason === "replayed"
      ? json({ error: "This webhook-id was already received" }, 409)
      : json({ error: "Missing or invalid signature" }, 401);
  }

  if (trigger.signingSecret) {
    const limited = await overRunLimit(trigger);
    if (limited) {
      // No run started: the sender may retry the same message once the window has passed.
      await verification.release();
      return limited;
    }
  }

  let run: Run;
  try {
    run = await fireTrigger(trigger, prettyPayload(raw.toString("utf8")));
  } catch (error) {
    await verification.release();
    // The trigger's agent left its project's team: nothing runs until the trigger is fixed.
    if (error instanceof AgentNotOnTeamError) return json({ error: error.message }, 409);
    throw error;
  }
  await audit({
    actor: "webhook",
    action: "webhook.received",
    entityType: "trigger",
    entityId: trigger.id,
    data: { runId: run.id, bytes: raw.byteLength },
  });
  return json({ runId: run.id }, 202);
}

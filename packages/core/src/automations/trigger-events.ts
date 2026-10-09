/** Event trigger kinds. Pure and client-safe; labels live in automations.events.<key>. */
export const TRIGGER_EVENTS = [
  { value: "webhook", key: "webhook" },
  { value: "task.created", key: "taskCreated" },
  { value: "task.done", key: "taskDone" },
  { value: "email.received", key: "emailReceived" },
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]["value"];
type TriggerEventKey = (typeof TRIGGER_EVENTS)[number]["key"];

export const TRIGGER_EVENT_VALUES = TRIGGER_EVENTS.map((e) => e.value) as [TriggerEvent, ...TriggerEvent[]];

/** Events delivered over HTTP: they need a public token and fire from the webhook route. */
export const WEBHOOK_EVENTS: TriggerEvent[] = ["webhook", "email.received"];

export const usesWebhook = (event: string) => (WEBHOOK_EVENTS as string[]).includes(event);

/**
 * Requests that may start runs per webhook trigger and window, counted from the first one: every
 * request for a trigger without a signing secret, only verified ones for a trigger with one. A trigger
 * may set its own number per minute, within WEBHOOK_RATE_LIMIT_BOUNDS.
 */
export const WEBHOOK_RATE_LIMIT = { requests: 30, windowSeconds: 60 } as const;

/** Requests that fail verification per webhook trigger and window before they are answered with 429. */
export const WEBHOOK_REFUSED_LIMIT = { requests: 120, windowSeconds: 60 } as const;

/** A trigger's own run limit per minute; below the refused limit, so failed requests never use up the real sender's. */
export const WEBHOOK_RATE_LIMIT_BOUNDS = { min: 1, max: 100 } as const;

/** The run limit of a trigger: its own per minute, or the default. */
export const webhookRateLimit = (trigger: { rateLimitPerMinute: number | null }) => ({
  requests: trigger.rateLimitPerMinute ?? WEBHOOK_RATE_LIMIT.requests,
  windowSeconds: WEBHOOK_RATE_LIMIT.windowSeconds,
});

/** How far a signed request's timestamp may be from now, in either direction. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Message key under automations.events, or null for an unknown event (show it raw). */
export const eventKey = (event: string): TriggerEventKey | null =>
  TRIGGER_EVENTS.find((e) => e.value === event)?.key ?? null;

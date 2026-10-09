import type { RunFailureKind } from "../runs/run-failures";
import type { SettingsDomain } from "../settings/settings-schema";
import { createRedis, redis } from "./redis";

/** Live events pushed from the worker to the web UI over Redis pub/sub. */
export type AppEvent =
  | { type: "run.updated"; runId: string; agentId: string | null; conversationId: string | null; status: string }
  /** Asks the worker executing the run to abort it; the run ends cancelled with `reason` and `kind`. */
  | { type: "run.cancel"; runId: string; reason: string; kind: RunFailureKind }
  | { type: "task.updated"; taskId: string; projectId: string | null }
  /** A message was added to the conversation outside a run (a delegation report delivered to the user). */
  | { type: "conversation.updated"; conversationId: string }
  | { type: "approval.created"; approvalId: string }
  | { type: "approval.decided"; approvalId: string; status: string }
  /** When active, workers abort their running runs with `reason`. */
  | { type: "kill-switch"; active: boolean; reason?: string }
  /** The worker stored a new sandbox status; read it with getSandboxStatus(). */
  | { type: "sandbox.status" }
  /** The Telegram bot token was saved or removed; the worker restarts or stops the bot. */
  | { type: "telegram.config-changed" }
  /** The worker stored a new bot status; read it with getTelegramBotStatus(). */
  | { type: "telegram.status" }
  /**
   * A settings domain was saved; every process drops its cached settings and the worker applies what it
   * holds in memory (run concurrency, maintenance schedules).
   */
  | { type: "settings.updated"; domain: SettingsDomain }
  /** The re-embedding after an embedding provider change moved on; read it with getReindexState(). */
  | { type: "embeddings.reindex" };

const CHANNEL = "abotica:events";

export async function publish(event: AppEvent): Promise<void> {
  await redis().publish(CHANNEL, JSON.stringify(event));
}

/** Returns an unsubscribe function. Uses a dedicated connection. */
export function subscribe(handler: (event: AppEvent) => void): () => void {
  const sub = createRedis();
  void sub.subscribe(CHANNEL);
  sub.on("message", (_channel, message) => {
    try {
      handler(JSON.parse(message) as AppEvent);
    } catch {
      // ignore malformed events
    }
  });
  return () => void sub.quit();
}

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  APP_URL: z.string().default("http://localhost:3000"),
  /** Extra public origins (tunnels, a second domain), comma separated. */
  TRUSTED_ORIGINS: z.string().optional(),
  VAULT_KEY: z.string().min(1, "VAULT_KEY is required (openssl rand -base64 32)"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
    ),
  TELEGRAM_NOTIFY_CHAT_ID: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  EMBEDDING_PROVIDER: z.enum(["openai", "ollama"]).default("openai"),
  /** Task attachments folder, shared by the web app and the worker. See uploadsRoot(). */
  UPLOADS_DIR: z.string().optional(),
  /** Runs one worker executes at the same time. */
  RUN_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /**
   * On shutdown (restart, update), how long the runs in progress get to finish on their own before
   * they are stopped and their partial answers saved. Keep it below the compose stop_grace_period.
   */
  WORKER_SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(30_000),
  /** Docker Engine API for sandbox containers (e.g. tcp://docker-proxy:2375); unset disables the Docker backend. */
  SANDBOX_DOCKER_HOST: z.string().optional(),
  /** Internal network the sandbox containers and the worker share. */
  SANDBOX_DOCKER_NETWORK: z.string().default("abotica-sandbox"),
  SANDBOX_IMAGE: z.string().default("abotica-sandbox:latest"),
  /**
   * Base of preview links: each preview is served at <code>.<host of this URL>. In production a
   * wildcard DNS name routed to the worker's preview port, e.g. https://preview.example.com.
   */
  PREVIEW_URL: z.string().default("http://preview.localhost:3100"),
  /** Port the worker serves previews on. */
  PREVIEW_PORT: z.coerce.number().int().positive().default(3100),
});

type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Parsed lazily so importing core never crashes a build step that lacks env vars.
 * A variable left empty in .env (`NAME=`) counts as not set, so defaults and fallbacks apply.
 */
export function env(): Env {
  cached ??= schema.parse(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value?.trim())));
  return cached;
}

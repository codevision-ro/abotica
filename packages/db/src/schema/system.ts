import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { projects } from "./projects";

/** Encrypted vault for API keys and tokens (AES-256-GCM, key from VAULT_KEY). */
export const secrets = pgTable("secrets", {
  id: id(),
  name: text().notNull().unique(),
  description: text().notNull().default(""),
  value: text().notNull(),
  projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    /** "user" | "agent:<slug>" | "system" */
    actor: text().notNull(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.createdAt), index().on(t.entityType, t.entityId)],
);

/** The app settings, one row per domain (key = domain); only the saved fields, see core settings.ts. */
export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
});

/** Internal bookkeeping that is not configuration: one-time imports, progress of background work. */
export const appState = pgTable("app_state", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt(),
});

/** The signed-in account behind a subscription connection, from its verified ID token. */
export type SubscriptionAccount = { subject: string; email: string | null; name: string | null };

/**
 * Accounts that bill a provider's models to the user's own plan (OpenAI through a ChatGPT plan)
 * instead of an API key, one per provider. Signing out clears the tokens but keeps the issued client
 * and the host id, so signing in again reuses the same registration.
 */
export const subscriptionConnections = pgTable("subscription_connections", {
  /** Provider id from the model catalog, e.g. "openai". */
  provider: text().primaryKey(),
  /** Stable, opaque id of this installation, sent with every authorization. */
  hostId: text().notNull(),
  /** OAuth client issued by dynamic registration on the first sign-in. */
  clientId: text(),
  account: jsonb().$type<SubscriptionAccount>(),
  /** Encrypted JSON token set (access, refresh, ID token); null when signed out. */
  tokens: text(),
  scopes: text().array().notNull().default([]),
  expiresAt: timestamp({ withTimezone: true }),
  connectedAt: timestamp({ withTimezone: true }),
  /** Why the connection stopped working (refresh refused, access revoked); cleared on success. */
  lastError: text(),
  updatedAt: updatedAt(),
});

import "server-only";
import {
  type CatalogModel,
  cheapestToolModel,
  getCatalog,
  getSettings,
  getSubscriptionStatus,
  getTelegramBotStatus,
  isKillSwitchActive,
  isSubscriptionProviderId,
  type ModelRole,
  modelRole,
  PROVIDER_IDS,
  PROVIDER_KEY_SECRET,
  type ProviderConnection,
  providerConnection,
  PROVIDERS,
  type ProviderId,
  storedSettings,
  type SubscriptionStatus,
  TELEGRAM_TOKEN_SECRET,
} from "@abotica/core";
import { agents, auditLogs, db, projects, secrets } from "@abotica/db";
import { and, asc, count, desc, eq, inArray, isNull } from "@abotica/db/orm";
import { publicQuery, query } from "@/server/query";

/** The app-wide settings, every domain with its defaults filled in. */
export const getAppSettings = query(() => getSettings());

/** Once a time zone is stored it stays stored, so after that the check costs nothing (per process). */
let timeZoneStored = false;

/**
 * Whether no time zone was ever saved (a new install): the app layout then saves the browser's once
 * (TimeZoneDetect). Installs from before keep the one the migration stored.
 */
export const getTimeZoneUnset = query(async (): Promise<boolean> => {
  if (timeZoneStored) return false;
  timeZoneStored = (await storedSettings()).general?.timezone !== undefined;
  return !timeZoneStored;
});

/** Whether the kill switch is stopping all runs. Public: the webhook route needs it, and it is one boolean. */
export const getKillSwitchState = publicQuery(() => isKillSwitchActive());

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  /** How it is connected now; null when it is not. */
  connection: ProviderConnection | null;
  /** Vault name of its API key; null for a local server. */
  keyName: string | null;
  /** When the saved key last changed; null without a key. */
  keyUpdatedAt: Date | null;
  /** The plan it can connect through instead of a key, and that connection's state. */
  plan: (SubscriptionStatus & { label: string }) | null;
  modelCount: number;
  /** The model the connection test runs on. */
  testModel: string | null;
  /** Only for Ollama. */
  models: string[];
};

export const listProviderStatuses = query(async (): Promise<ProviderStatus[]> => {
  const names = PROVIDER_IDS.map((p) => PROVIDER_KEY_SECRET[p]).filter((n): n is string => Boolean(n));
  const [rows, catalog] = await Promise.all([
    db.select({ name: secrets.name, updatedAt: secrets.updatedAt }).from(secrets).where(inArray(secrets.name, names)),
    getCatalog().catch(() => [] as CatalogModel[]),
  ]);
  const keys = new Map(rows.map((r) => [r.name, r.updatedAt]));
  return Promise.all(
    PROVIDER_IDS.map(async (id) => {
      const keyName = PROVIDER_KEY_SECRET[id];
      const models = catalog.filter((m) => m.provider === id);
      const planLabel = isSubscriptionProviderId(id) ? PROVIDERS[id].plan : null;
      return {
        id,
        label: PROVIDERS[id].label,
        connection: await providerConnection(id),
        keyName,
        keyUpdatedAt: keyName ? (keys.get(keyName) ?? null) : null,
        plan: isSubscriptionProviderId(id) && planLabel ? { label: planLabel, ...(await getSubscriptionStatus(id)) } : null,
        modelCount: models.length,
        testModel: cheapestToolModel(catalog, id)?.id ?? null,
        models: id === "ollama" ? models.map((m) => m.id) : [],
      } satisfies ProviderStatus;
    }),
  );
});

export const listVaultSecrets = query(async () => {
  return db
    .select({
      id: secrets.id,
      name: secrets.name,
      description: secrets.description,
      projectId: secrets.projectId,
      projectName: projects.name,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .leftJoin(projects, eq(projects.id, secrets.projectId))
    .orderBy(asc(secrets.name));
});

export type VaultSecretRow = Awaited<ReturnType<typeof listVaultSecrets>>[number];

/** Agents without a model of their own, by the role whose default they follow (see modelRole). */
export const getInheritingAgentCount = query(async (): Promise<Record<ModelRole, number>> => {
  const rows = await db
    .select({ kind: agents.kind })
    .from(agents)
    .where(and(isNull(agents.provider), eq(agents.isTemplate, false)));
  const counts: Record<ModelRole, number> = { orchestrator: 0, manager: 0, agent: 0 };
  for (const row of rows) counts[modelRole(row)]++;
  return counts;
});

export const AUDIT_PAGE_SIZE = 50;

export const getAuditLogPage = query(async (filter: { actor?: string; entityType?: string; page: number }) => {
  const where = and(
    filter.actor ? eq(auditLogs.actor, filter.actor) : undefined,
    filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
  );
  const [rows, [total], actors, entityTypes] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(AUDIT_PAGE_SIZE)
      .offset((filter.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ n: count() }).from(auditLogs).where(where),
    db.selectDistinct({ v: auditLogs.actor }).from(auditLogs).orderBy(asc(auditLogs.actor)),
    db.selectDistinct({ v: auditLogs.entityType }).from(auditLogs).orderBy(asc(auditLogs.entityType)),
  ]);
  return {
    rows,
    total: total?.n ?? 0,
    actors: actors.map((r) => r.v),
    entityTypes: entityTypes.map((r) => r.v),
  };
});

/** Settings > Telegram: the stored configuration (never the token itself) and what the worker's bot reports. */
export const getTelegramStatus = query(async () => {
  const [[token], current, bot] = await Promise.all([
    db
      .select({ projectId: secrets.projectId, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(eq(secrets.name, TELEGRAM_TOKEN_SECRET)),
    getSettings(),
    getTelegramBotStatus().catch(() => null),
  ]);
  // A token bound to a project is not the bot's (see getSecret).
  const tokenUpdatedAt = token?.projectId === null ? token.updatedAt : null;
  return {
    /** When the bot token last changed; null without one. */
    tokenUpdatedAt,
    allowedUserIds: current.telegram.allowedUserIds,
    notifyChatId: current.telegram.notifyChatId,
    /** What the worker's bot reports; null while it starts, or when no worker runs it. */
    bot,
  };
});

export type TelegramStatus = Awaited<ReturnType<typeof getTelegramStatus>>;

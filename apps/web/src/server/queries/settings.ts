import "server-only";
import {
  type CatalogModel,
  cheapestToolModel,
  getCatalog,
  getSettings,
  getSubscriptionStatus,
  isKillSwitchActive,
  isSubscriptionProviderId,
  PROVIDER_IDS,
  PROVIDER_KEY_SECRET,
  type ProviderConnection,
  providerConnection,
  PROVIDERS,
  type ProviderId,
  type SubscriptionStatus,
} from "@abotica/core";
import { agents, auditLogs, db, projects, secrets } from "@abotica/db";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from "@abotica/db/orm";
import { publicQuery, query } from "@/server/query";

/** The app-wide settings (Settings > General). */
export const getAppSettings = query(() => getSettings());

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

/** Agents without a model of their own, which follow the default models. */
export const getInheritingAgentCount = query(async (): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(agents)
    .where(and(isNull(agents.provider), eq(agents.isTemplate, false)));
  return row?.n ?? 0;
});

export const listProjectOptions = query(async () => {
  return db.select({ id: projects.id, name: projects.name }).from(projects).orderBy(asc(projects.name));
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

export const getTelegramStatus = query(async () => {
  const allowed = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const topics = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, topicId: projects.telegramTopicId })
    .from(projects)
    .where(isNotNull(projects.telegramTopicId))
    .orderBy(asc(projects.name));
  const [all] = await db.select({ n: count() }).from(projects);
  return {
    tokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    allowedUserIds: allowed,
    notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID || null,
    topics,
    projectCount: all?.n ?? 0,
  };
});

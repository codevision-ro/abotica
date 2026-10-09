/**
 * Stored settings: one row per domain in `settings`, holding only what was saved, so a setting never
 * saved keeps following its default (settings-schema.ts). Every write goes through updateSettings, which
 * validates, records the change in the audit log and tells the other processes.
 */
import { db, settings as settingsTable } from "@abotica/db";
import { eq, inArray } from "@abotica/db/orm";
import { defaultLocale, type Locale, UserError } from "@abotica/i18n";
import { publish } from "../infra/events";
import { audit } from "../platform/audit";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  SETTINGS_DOMAINS,
  SETTINGS_SCHEMAS,
  type SettingsDomain,
  settingsIssueValues,
  type SettingsPatch,
} from "./settings-schema";

export * from "./settings-schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What is stored per domain: the fields saved so far, nested objects possibly partial. */
export type StoredSettings = { [D in SettingsDomain]?: SettingsPatch<AppSettings[D]> };

/** Language for places without a browser to ask (Telegram, digests, notifications). */
export function settingsLocale(settings: AppSettings): Locale {
  return settings.general.locale ?? defaultLocale;
}

/**
 * Settings are read on almost every request and job, and written rarely: they are kept for a few
 * seconds per process. A write clears it here, and the settings.updated event clears it in the
 * worker (see invalidateSettings). On globalThis, so every bundle of the web server shares one copy.
 */
const CACHE_MS = 5_000;
const cacheHolder = globalThis as typeof globalThis & { __aboticaSettings?: { at: number; value: AppSettings } };

export function invalidateSettings(): void {
  cacheHolder.__aboticaSettings = undefined;
}

export async function storedSettings(tx: Tx | typeof db = db): Promise<StoredSettings> {
  const rows = await tx
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(inArray(settingsTable.key, [...SETTINGS_DOMAINS]));
  return Object.fromEntries(rows.map((row) => [row.key, row.value])) as StoredSettings;
}

/**
 * A stored domain on top of its defaults. A stored field that no longer validates (a bound tightened
 * since it was saved) falls back to its default instead of failing every reader.
 */
function resolveDomain<D extends SettingsDomain>(domain: D, stored: unknown): AppSettings[D] {
  const merged = mergeSettings(DEFAULT_SETTINGS[domain], stored);
  const schema = SETTINGS_SCHEMAS[domain];
  const parsed = schema.safeParse(merged);
  if (parsed.success) return parsed.data as AppSettings[D];
  const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  console.warn(`[settings] ${domain}: ${[...bad].join(", ")} invalid in storage, using the defaults`);
  const repaired = Object.fromEntries(
    Object.entries(merged as Record<string, unknown>).map(([key, value]) => [
      key,
      bad.has(key) ? (DEFAULT_SETTINGS[domain] as Record<string, unknown>)[key] : value,
    ]),
  );
  return (schema.safeParse(repaired).data ?? DEFAULT_SETTINGS[domain]) as AppSettings[D];
}

export async function getSettings(): Promise<AppSettings> {
  const cached = cacheHolder.__aboticaSettings;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const stored = await storedSettings();
  const value = Object.fromEntries(
    SETTINGS_DOMAINS.map((domain) => [domain, resolveDomain(domain, stored[domain])]),
  ) as AppSettings;
  cacheHolder.__aboticaSettings = { at: Date.now(), value };
  return value;
}

/** The validated domain, or the first problem as a UserError with its message key. */
export function validateSettings<D extends SettingsDomain>(domain: D, value: unknown): AppSettings[D] {
  const parsed = SETTINGS_SCHEMAS[domain].safeParse(value);
  if (parsed.success) return parsed.data as AppSettings[D];
  const issue = parsed.error.issues[0]!;
  throw new UserError(issue.message, settingsIssueValues(issue));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields of `shape` (what is stored) taken from `full` (validated), so normalized values are kept. */
function pickStored(full: unknown, shape: unknown): unknown {
  if (!isPlainObject(full) || !isPlainObject(shape)) return full;
  return Object.fromEntries(Object.keys(shape).map((key) => [key, pickStored(full[key], shape[key])]));
}

/** Dotted paths whose value differs, for the audit log; long text is logged as its length. */
function changes(before: unknown, after: unknown, path = ""): Record<string, unknown> {
  if (isPlainObject(before) && isPlainObject(after)) {
    return Object.assign(
      {},
      ...[...new Set([...Object.keys(before), ...Object.keys(after)])].map((key) =>
        changes(before[key], after[key], path ? `${path}.${key}` : key),
      ),
    );
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return {};
  if (typeof before === "string" && typeof after === "string" && Math.max(before.length, after.length) > 200) {
    return { [path]: { fromLength: before.length, toLength: after.length } };
  }
  return { [path]: { from: before ?? null, to: after ?? null } };
}

type UpdateOptions = {
  /** Who changed it, for the audit log: "user" (default), "system" or "agent:<slug>". */
  actor?: string;
  /**
   * Joins a transaction of the caller. The change is not visible to others before the commit, so the
   * caller calls announceSettings(domain) after it.
   */
  tx?: Tx;
};

/** Drops the cached settings here and tells the other processes (the worker) that `domain` changed. */
export async function announceSettings(domain: SettingsDomain): Promise<void> {
  invalidateSettings();
  await publish({ type: "settings.updated", domain }).catch((error: unknown) => {
    console.warn("[settings] could not announce the change:", error);
  });
}

/**
 * Saves a change to one domain on top of what is stored, validated as a whole with the defaults filled
 * in. The row is locked while it changes, so two saves at the same moment do not lose each other's
 * fields. Returns the domain as it is now.
 */
export async function updateSettings<D extends SettingsDomain>(
  domain: D,
  patch: SettingsPatch<AppSettings[D]>,
  options: UpdateOptions = {},
): Promise<AppSettings[D]> {
  const run = async (tx: Tx) => {
    await tx.insert(settingsTable).values({ key: domain, value: {} }).onConflictDoNothing();
    const [row] = await tx
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, domain))
      .for("update");
    const stored = mergeSettings((row?.value ?? {}) as Record<string, unknown>, patch);
    const before = resolveDomain(domain, row?.value);
    const after = validateSettings(domain, mergeSettings(DEFAULT_SETTINGS[domain], stored));
    await tx
      .update(settingsTable)
      .set({ value: pickStored(after, stored) })
      .where(eq(settingsTable.key, domain));
    const changed = changes(before, after);
    if (Object.keys(changed).length) {
      await audit(
        {
          actor: options.actor ?? "user",
          action: "settings.updated",
          entityType: "settings",
          entityId: domain,
          data: changed,
        },
        tx,
      );
    }
    return { after, changed: Object.keys(changed).length > 0 };
  };
  if (options.tx) return (await run(options.tx)).after;
  const { after, changed } = await db.transaction(run);
  if (changed) await announceSettings(domain);
  else invalidateSettings();
  return after;
}

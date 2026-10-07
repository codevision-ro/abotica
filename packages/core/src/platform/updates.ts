import { getTranslator } from "@abotica/i18n";
import { notify } from "../infra/queues";
import { redis } from "../infra/redis";
import { getSettings, settingsLocale } from "./settings";

/** Where releases are published; install.sh and install.ps1 install from the same repository. */
export const RELEASES_REPO = "codevision-ro/abotica";
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
const STATE_KEY = "abotica:updates:state";
const notifiedKey = (version: string) => `abotica:updates:notified:${version}`;
const FETCH_TIMEOUT_MS = 10_000;
/** Release notes are kept to this many characters; the release page has the rest. */
const NOTES_LIMIT = 20_000;

export type ReleaseInfo = {
  version: string;
  url: string;
  /** Markdown, as written on the GitHub release. */
  notes: string;
  publishedAt: string;
};

export type UpdateStatus = {
  /** Settings: checks are on (they call GitHub's API once every few hours). */
  enabled: boolean;
  /** The release this instance runs; null when it runs from source (development). */
  current: string | null;
  /** The latest release seen by the last check, null before the first one. */
  latest: ReleaseInfo | null;
  /** A newer release than `current` exists. */
  available: boolean;
  checkedAt: string | null;
  /** Why the last check failed, if it did. */
  error: string | null;
};

type StoredState = { latest: ReleaseInfo | null; checkedAt: string; error: string | null };

/** ABOTICA_VERSION: baked into the published images and written into .env by the installers. */
export function currentVersion(): string | null {
  const version = process.env.ABOTICA_VERSION?.trim().replace(/^v/, "");
  return version ? version : null;
}

/** Semver order of "1.2.3" and "1.2.3-rc.1": negative when a < b. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

function toStatus(enabled: boolean, stored: StoredState | null): UpdateStatus {
  const current = currentVersion();
  const latest = stored?.latest ?? null;
  return {
    enabled,
    current,
    latest,
    available: Boolean(current && latest && compareVersions(latest.version, current) > 0),
    checkedAt: stored?.checkedAt ?? null,
    error: stored?.error ?? null,
  };
}

async function readState(): Promise<StoredState | null> {
  const raw = await redis().get(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

/** What the last check found, without calling GitHub. */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const [settings, stored] = await Promise.all([getSettings(), readState()]);
  return toStatus(settings.updateChecks, stored);
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "abotica-update-check" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string; body?: string | null; published_at?: string };
  if (!body.tag_name || !body.html_url) throw new Error("GitHub sent a release without a tag");
  return {
    version: body.tag_name.replace(/^v/, ""),
    url: body.html_url,
    notes: (body.body ?? "").slice(0, NOTES_LIMIT),
    publishedAt: body.published_at ?? new Date().toISOString(),
  };
}

/**
 * Asks GitHub for the latest release and keeps the answer. A failed check keeps the release found
 * before, with the error next to it. Runs even when checks are off if `force` is set (the user's
 * "Check now").
 */
export async function checkForUpdates({ force = false }: { force?: boolean } = {}): Promise<UpdateStatus> {
  const settings = await getSettings();
  const before = await readState();
  if (!settings.updateChecks && !force) return toStatus(false, before);
  let state: StoredState;
  try {
    state = { latest: await fetchLatestRelease(), checkedAt: new Date().toISOString(), error: null };
  } catch (error) {
    state = {
      latest: before?.latest ?? null,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await redis().set(STATE_KEY, JSON.stringify(state));
  return toStatus(settings.updateChecks, state);
}

/** Tells the user on Telegram about a new release, once per version. Returns whether it sent one. */
export async function notifyUpdateAvailable(status: UpdateStatus): Promise<boolean> {
  if (!status.enabled || !status.available || !status.latest) return false;
  const { version, url } = status.latest;
  if ((await redis().set(notifiedKey(version), "1", "NX")) !== "OK") return false;
  const t = getTranslator(settingsLocale(await getSettings()));
  await notify({
    kind: "text",
    text: t("notifications.update.available", { version, current: status.current ?? "", url }),
  });
  return true;
}

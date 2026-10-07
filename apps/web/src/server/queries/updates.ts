import "server-only";
import { getUpdateStatus as readUpdateStatus, listActiveRuns, RELEASES_REPO } from "@abotica/core";
import { query } from "@/server/query";

/**
 * Settings > Updates: what the last check found (no call to GitHub), where releases live and how many
 * runs are executing, which an update stops (queued and waiting ones just wait for the new worker).
 */
export const getUpdatesPage = query(async () => {
  const [status, active] = await Promise.all([readUpdateStatus(), listActiveRuns()]);
  return { status, repo: RELEASES_REPO, runningRuns: active.filter((r) => r.status === "running").length };
});

/** The newer release for the sidebar notice, or null. Never fails the layout: a broken Redis just hides it. */
export const getAvailableUpdate = query(async (): Promise<string | null> => {
  const status = await readUpdateStatus().catch(() => null);
  return status?.available && status.latest ? status.latest.version : null;
});

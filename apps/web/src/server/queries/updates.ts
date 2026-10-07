import "server-only";
import { getUpdateStatus as readUpdateStatus, RELEASES_REPO } from "@abotica/core";
import { query } from "@/server/query";

/** Settings > Updates: what the last check found (no call to GitHub) and where releases live. */
export const getUpdatesPage = query(async () => ({ status: await readUpdateStatus(), repo: RELEASES_REPO }));

/** The newer release for the sidebar notice, or null. Never fails the layout: a broken Redis just hides it. */
export const getAvailableUpdate = query(async (): Promise<string | null> => {
  const status = await readUpdateStatus().catch(() => null);
  return status?.available && status.latest ? status.latest.version : null;
});

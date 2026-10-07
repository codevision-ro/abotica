import "server-only";
import { getSandboxStatus, getSettings } from "@abotica/core";
import { query } from "@/server/query";

/** What the worker found when it last checked the sandbox; null before its first check. */
export type SandboxStatusView = Awaited<ReturnType<typeof getSandboxStatus>>;

/** Settings > Sandbox: saved settings and the latest status the worker stored. */
export const getSandboxPage = query(async () => {
  const [settings, status] = await Promise.all([getSettings(), getSandboxStatus()]);
  return { settings: settings.sandbox, status };
});

/**
 * Sandbox status and requests, safe for the web app: it reads what the worker stored and asks the
 * worker for work through the queues. The backend itself lives in `sandbox-runtime.ts` (worker only).
 */
import { db, projects } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import type { SandboxStatus } from "@abotica/sandbox";
import { audit } from "../platform/audit";
import { maintenanceQueue } from "../infra/queues";
import { redis } from "../infra/redis";
import { projectWorkspaceKey } from "./sandbox-keys";

export type { Isolation, SandboxStatus } from "@abotica/sandbox";
export { conversationWorkspaceKey, projectWorkspaceKey, workspaceOwner } from "./sandbox-keys";

export const SANDBOX_STATUS_KEY = "abotica:sandbox:status";
/** Hash of workspace key -> ISO time it was last opened; backends may not know it themselves. */
const LAST_USED_KEY = "abotica:sandbox:last-used";

/** The status the worker stored last; null before a worker ever started. */
export async function getSandboxStatus(): Promise<SandboxStatus | null> {
  const raw = await redis().get(SANDBOX_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SandboxStatus;
  } catch {
    return null;
  }
}

/** Asks the worker to detect the backends again (after the settings change, or "Check again"). */
export async function requestSandboxCheck(): Promise<void> {
  await maintenanceQueue().add("sandbox-check", { kind: "sandbox-check" }, { attempts: 1 });
}

/** Removals the worker has not done yet; kept until they succeed, so none is lost while no backend runs. */
const PENDING_REMOVALS_KEY = "abotica:sandbox:pending-removals";

/** Asks the worker to delete a workspace with its files; a missing one is a no-op. */
export async function requestWorkspaceRemoval(key: string): Promise<void> {
  await redis().sadd(PENDING_REMOVALS_KEY, key);
  await maintenanceQueue().add(
    "sandbox-remove",
    { kind: "sandbox-remove", key },
    // Retries cover a backend that is briefly down; the pending set covers a longer outage.
    { attempts: 6, backoff: { type: "exponential", delay: 30_000 } },
  );
}

export async function pendingWorkspaceRemovals(): Promise<string[]> {
  return redis().smembers(PENDING_REMOVALS_KEY);
}

export async function clearPendingWorkspaceRemoval(key: string): Promise<void> {
  await redis().srem(PENDING_REMOVALS_KEY, key);
}

/** Records that a workspace was opened, for the reaper. */
export async function touchWorkspace(key: string): Promise<void> {
  await redis().hset(LAST_USED_KEY, key, new Date().toISOString());
}

/** Workspace key -> ISO time it was last opened. */
export async function workspaceLastUse(): Promise<Record<string, string>> {
  return redis().hgetall(LAST_USED_KEY);
}

export async function forgetWorkspaceUse(keys: string[]): Promise<void> {
  if (keys.length) await redis().hdel(LAST_USED_KEY, ...keys);
}

/** Deletes the project's workspace: files, installed packages and caches start fresh on the next run. */
export async function resetProjectWorkspace(projectId: string, actor: string): Promise<void> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new UserError("projects.errors.notFound");
  await requestWorkspaceRemoval(projectWorkspaceKey(projectId));
  await audit({
    actor,
    action: "project.workspace-reset",
    entityType: "project",
    entityId: projectId,
    data: { name: project.name },
  });
}

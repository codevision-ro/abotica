/**
 * The sandbox backend and its lifecycle. Worker only: it value-imports `@abotica/sandbox` (Docker),
 * so it is not exported from the package index and the web app never loads it.
 */
import { conversations, db, mcpServers, projects } from "@abotica/db";
import { inArray } from "@abotica/db/orm";
import { type BackendOptions, createBackend, type SandboxBackend, type SandboxStatus } from "@abotica/sandbox";
import { mcpWorkspaceKeys } from "../agents/mcp";
import { env } from "../infra/env";
import { publish } from "../infra/events";
import { redis } from "../infra/redis";
import {
  clearPendingWorkspaceRemoval,
  forgetWorkspaceUse,
  pendingWorkspaceRemovals,
  SANDBOX_STATUS_KEY,
  touchWorkspace,
  workspaceLastUse,
} from "./sandbox";
import { workspaceOwner } from "./sandbox-keys";
import { getSettings, type SandboxSettings } from "../settings/settings";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * When idle workspaces are paused, stopped and deleted (the sandbox part of Settings > System). A paused container keeps
 * its memory, frozen; one with a process still running in the background (a build, a crawl, a dev
 * server) is not paused, so that work goes on. A stopped container keeps its volume.
 */
export function idleTimings(settings: SandboxSettings) {
  return {
    pauseAfterMs: settings.pauseIdleMinutes * MINUTE_MS,
    stopAfterMs: settings.stopIdleHours * HOUR_MS,
    conversationTtlMs: settings.workspaceRetentionDays * DAY_MS,
  };
}

const globalForSandbox = globalThis as unknown as {
  aboticaSandbox?: { backend: SandboxBackend | null; options: string | null; status: SandboxStatus | null };
};
const state = (globalForSandbox.aboticaSandbox ??= { backend: null, options: null, status: null });
let initQueue: Promise<unknown> = Promise.resolve();

function backendOptions(settings: SandboxSettings): BackendOptions {
  const e = env();
  return {
    enabled: settings.enabled,
    ...(e.SANDBOX_DOCKER_HOST && {
      docker: {
        host: e.SANDBOX_DOCKER_HOST,
        network: e.SANDBOX_DOCKER_NETWORK,
        image: e.SANDBOX_IMAGE,
        runtime: settings.runtime,
        limits: { memoryMb: settings.memoryMb, cpus: settings.cpus, pids: settings.pids },
      },
    }),
  };
}

async function storeStatus(status: SandboxStatus) {
  state.status = status;
  await redis().set(SANDBOX_STATUS_KEY, JSON.stringify(status));
  await publish({ type: "sandbox.status" });
}

/**
 * Worker only: creates the backend from the settings and the environment, stores the status in
 * Redis and announces it. Calls are serialized. When the options did not change and a backend is
 * running, it is kept (recreating it would cut off the commands running in it) and only the
 * status is refreshed.
 */
export function initSandbox(): Promise<SandboxStatus> {
  const next = initQueue.then(async () => {
    const options = backendOptions((await getSettings()).sandbox);
    const fingerprint = JSON.stringify(options);
    if (state.backend && state.status && state.options === fingerprint) {
      const status = { ...state.status, checkedAt: new Date().toISOString() };
      await storeStatus(status);
      return status;
    }
    const previous = state.backend;
    state.backend = null;
    state.options = null;
    await previous?.close().catch((error: unknown) => console.error("[sandbox] closing the old backend failed:", error));
    const { backend, status } = await createBackend(options);
    state.backend = backend;
    state.options = fingerprint;
    await storeStatus(status);
    // Removals requested while there was no backend (a project reset, a deleted chat) happen
    // now, before new runs can use those workspaces again.
    if (backend) await processPendingRemovals();
    return status;
  });
  initQueue = next.catch(() => {});
  return next;
}

/** Every MCP workspace key that may exist now: each server in each scope. */
async function liveMcpWorkspaceKeys(): Promise<Set<string>> {
  const [servers, allProjects] = await Promise.all([
    db.select({ slug: mcpServers.slug }).from(mcpServers),
    db.select({ id: projects.id }).from(projects),
  ]);
  const projectIds = allProjects.map((p) => p.id);
  return new Set(servers.flatMap((s) => mcpWorkspaceKeys(s.slug, projectIds)));
}

/** Worker only: the backend in use, or null when none is available or the sandbox is off. */
export function currentSandboxBackend(): SandboxBackend | null {
  return state.backend;
}

/** Worker only: shuts the backend down (egress proxy, connections) on exit. */
export async function closeSandbox(): Promise<void> {
  const backend = state.backend;
  state.backend = null;
  state.options = null;
  await backend?.close();
}

/**
 * Worker only: deletes a workspace now. Without a backend it throws, so the job is retried and
 * the request stays pending until a backend can carry it out.
 */
export async function removeWorkspace(key: string): Promise<void> {
  const backend = state.backend;
  if (!backend) throw new Error(`No sandbox backend is available to remove workspace ${key}`);
  await backend.remove(key);
  await forgetWorkspaceUse([key]);
  await clearPendingWorkspaceRemoval(key);
}

/** Carries out removals whose jobs failed or ran while no backend was available. */
async function processPendingRemovals(): Promise<void> {
  for (const key of await pendingWorkspaceRemovals()) {
    try {
      await removeWorkspace(key);
    } catch (error) {
      console.error(`[sandbox] removing workspace ${key} failed:`, error);
    }
  }
}

/**
 * Worker only, every few minutes: pauses idle containers and stops long idle ones, removes
 * workspaces whose project, conversation, MCP server or secret scope is gone (and MCP workspaces
 * of the older unscoped form), and conversation workspaces unused longer than the retention setting.
 */
export async function reapSandbox(): Promise<void> {
  const backend = state.backend;
  if (!backend) return;
  const { pauseAfterMs, stopAfterMs, conversationTtlMs } = idleTimings((await getSettings()).sandbox);
  // One container that fails to pause or stop must not block the cleanup below.
  await backend
    .reap({ pauseAfterMs, stopAfterMs })
    .catch((error: unknown) => console.error("[sandbox] pausing or stopping idle workspaces failed:", error));
  await processPendingRemovals();

  const workspaces = await backend.list();
  const lastUsed = await workspaceLastUse();
  const owners = workspaces.flatMap((w) => {
    const owner = workspaceOwner(w.key);
    return owner ? [{ ...w, owner }] : [];
  });
  const ids = (kind: "project" | "conversation") => owners.flatMap((w) => (w.owner.kind === kind ? [w.owner.id] : []));

  const projectIds = ids("project");
  const conversationIds = ids("conversation");
  // Read after listing the workspaces: one opened since belongs to a server or project seen here.
  const [liveProjects, liveConversations, liveMcpKeys] = await Promise.all([
    projectIds.length ? db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds)) : [],
    conversationIds.length
      ? db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.id, conversationIds))
      : [],
    owners.some((w) => w.owner.kind === "mcp") ? liveMcpWorkspaceKeys() : new Set<string>(),
  ]);
  const alive = new Set([...liveProjects, ...liveConversations].map((r) => r.id));

  const now = Date.now();
  for (const { key, owner, lastUsedAt } of owners) {
    // An MCP key is live while its server and scope exist (the server's slug and the project).
    let remove = owner.kind === "mcp" ? !liveMcpKeys.has(key) : !alive.has(owner.id);
    if (!remove && owner.kind === "conversation") {
      const used = lastUsedAt?.getTime() ?? (lastUsed[key] ? Date.parse(lastUsed[key]) : NaN);
      // Unknown age: start the clock now instead of deleting a workspace that may be in use.
      if (Number.isNaN(used)) await touchWorkspace(key);
      else remove = now - used > conversationTtlMs;
    }
    if (!remove) continue;
    try {
      await removeWorkspace(key);
    } catch (error) {
      console.error(`[sandbox] removing workspace ${key} failed:`, error);
    }
  }

  // Forget last-use entries of workspaces that no longer exist.
  const existing = new Set(workspaces.map((w) => w.key));
  const stale = Object.keys(lastUsed).filter((key) => !existing.has(key));
  await forgetWorkspaceUse(stale);
}

/**
 * Docker backend: one long-lived container per workspace, its files in a named volume, commands
 * through exec. Containers start on first use, are paused when idle (no command and no background
 * process) and stopped after a longer idle (reap), and are recreated when their spec changes while
 * nothing runs in them. The egress proxy
 * runs in this process, on the worker's address in the sandbox network.
 *
 * Users: agent commands run as the sandbox user, stdio MCP servers as the MCP user. A workspace is
 * owned by the sandbox user, except an MCP server's own workspace, which belongs to the MCP user;
 * in the others an MCP server lives in folders outside the volume (MCP_PATHS) and never starts in
 * the workspace.
 */
import type Docker from "dockerode";
import { startEgressProxy } from "../egress/proxy";
import type { DockerBackendOptions, ExecOptions, SandboxBackend, SandboxProcess, Workspace, WorkspaceSpec } from "../types";
import {
  assertBundle,
  BUNDLE_STATE_FILE,
  bundleTar,
  parseBundleState,
  planBundleSync,
  planIsEmpty,
  type BundleState,
} from "./bundles";
import { dockerClient, errorMessage, statusOf, withTimeout } from "./client";
import { mcpExecOptions, runHelper, startProcess } from "./exec";
import { findWorkerAddress } from "./network";
import {
  assertWorkspaceKey,
  containerSpec,
  LABELS,
  MCP_PATHS,
  MCP_USER,
  PATHS,
  resourceName,
  ROOT_USER,
  SANDBOX_USER,
} from "./spec";

const API_TIMEOUT_MS = 30_000;
const IMAGE_CHECK_MS = 30_000;

type Usage = {
  /** Last open or exec in this process; null until one happens. */
  usedAt: number | null;
  /** First time reap saw the container up: after a worker restart, running and paused containers count as just used. */
  seenAt: number | null;
  active: Set<SandboxProcess>;
  /** Execs being created; counted so reap and recreate leave the container alone meanwhile. */
  starting: number;
};

type BundleCache = { containerId: string; startedAt: string; state: BundleState };

const MCP_UID = MCP_USER.split(":")[0]!;

/**
 * Run as root once per container start: creates the MCP user's folders (private ones, and the one
 * for files agent commands may read) and, in an MCP server's own workspace (`$1` = mcp), hands the
 * volume to that user the first time. Only root-owned paths are touched otherwise; under /workspace,
 * `find` does not follow links and `chown -h` changes a link itself, so nothing a server left there
 * redirects root.
 */
const PREPARE_USERS_SCRIPT = `set -e
/usr/bin/install -d -m 0755 ${MCP_PATHS.root}
/usr/bin/install -d -o ${MCP_UID} -g ${MCP_UID} -m 0700 ${MCP_PATHS.home} ${MCP_PATHS.tmp}
/usr/bin/install -d -o ${MCP_UID} -g ${MCP_UID} -m 0755 ${MCP_PATHS.out}
if [ "$1" = mcp ] && [ "$(/usr/bin/stat -c %u ${PATHS.workspace})" != ${MCP_UID} ]; then
  /usr/bin/find ${PATHS.workspace} -xdev ! -user ${MCP_UID} -exec /usr/bin/chown -h ${MCP_USER} {} +
fi
`;

const ownerUser = (spec: WorkspaceSpec) => (spec.owner === "mcp" ? MCP_USER : SANDBOX_USER);

/**
 * Prints the processes of a container besides its init (tini, PID 1), the `sleep infinity` that
 * keeps it up (the image's CMD, a child of init), zombies and itself: what an agent left running in
 * the background (a nohup build, a crawl, a dev server, a database from `services`). Shell builtins
 * only, so it starts no process of its own while it looks; /proc reads the same under runc and gVisor.
 */
const BACKGROUND_PROCESSES_SCRIPT = `for dir in /proc/[0-9]*; do
  pid=\${dir#/proc/}
  case "$pid" in 1|$$) continue ;; esac
  read -r stat 2>/dev/null < "$dir/stat" || continue
  comm=\${stat#*(}; comm=\${comm%)*}
  rest=\${stat##*) }; state=\${rest%% *}; rest=\${rest#* }; ppid=\${rest%% *}
  [ "$state" = Z ] && continue
  [ "$ppid" = 1 ] && [ "$comm" = sleep ] && continue
  echo "$pid $comm"
done
`;

const ignoreStatus =
  (...codes: number[]) =>
  (error: unknown) => {
    if (!codes.includes(statusOf(error) ?? 0)) throw error;
  };

export async function createDockerBackend(options: DockerBackendOptions): Promise<SandboxBackend> {
  const docker = dockerClient(options.host);
  const info = await withTimeout(docker.info(), API_TIMEOUT_MS, "Docker info");
  const runtimes = Object.keys((info as { Runtimes?: Record<string, unknown> }).Runtimes ?? {});
  const gvisor = runtimes.includes("runsc");
  if (options.runtime === "runsc" && !gvisor) throw new Error("The gVisor runtime (runsc) is not installed in Docker");
  const runtime = options.runtime === "runc" || !gvisor ? "runc" : "runsc";
  const address = await findWorkerAddress(docker, options.network);
  const networkId = (await withTimeout(docker.getNetwork(options.network).inspect(), API_TIMEOUT_MS, "Network inspect")).Id;
  const proxy = await startEgressProxy({ host: address });

  const usage = new Map<string, Usage>();
  const locks = new Map<string, Promise<unknown>>();
  const specs = new Map<string, WorkspaceSpec>();
  const bundleCache = new Map<string, BundleCache>();
  /** Container instance (`id/startedAt`) whose users and folders are prepared, by key. */
  const preparedUsers = new Map<string, string>();
  /** Each running container's address on the sandbox network; proxy tokens only work from there. */
  const addresses = new Map<string, string>();
  let image: { id: string; checkedAt: number } | null = null;

  const usageOf = (key: string): Usage => {
    let entry = usage.get(key);
    if (!entry) usage.set(key, (entry = { usedAt: null, seenAt: null, active: new Set(), starting: 0 }));
    return entry;
  };
  const busy = (key: string) => {
    const entry = usage.get(key);
    return !!entry && entry.active.size + entry.starting > 0;
  };
  const touch = (key: string) => (usageOf(key).usedAt = Date.now());

  /** Runs `task` after every earlier task for the same key, so opens, stops and removals never interleave. */
  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function imageId(): Promise<string> {
    if (image && Date.now() - image.checkedAt < IMAGE_CHECK_MS) return image.id;
    try {
      const inspected = await withTimeout(docker.getImage(options.image).inspect(), API_TIMEOUT_MS, "Image inspect");
      image = { id: inspected.Id, checkedAt: Date.now() };
      return inspected.Id;
    } catch (error) {
      if (statusOf(error) === 404) throw new Error(`Sandbox image ${options.image} not found`);
      throw error;
    }
  }

  /** The container's endpoint on the sandbox network, found by the network's name or else its id. */
  const endpointOf = (current: Docker.ContainerInspectInfo) => {
    const networks = current.NetworkSettings.Networks ?? {};
    return networks[options.network] ?? Object.values(networks).find((n) => n.NetworkID === networkId);
  };

  /** The address of a container that runs and is not paused; null otherwise. */
  const runningAddress = (current: Docker.ContainerInspectInfo | null) =>
    current?.State.Running && !current.State.Paused ? endpointOf(current)?.IPAddress || null : null;

  const inspect = (name: string) =>
    withTimeout(docker.getContainer(name).inspect(), API_TIMEOUT_MS, "Container inspect").catch((error: unknown) => {
      if (statusOf(error) === 404) return null;
      throw error;
    });

  async function removeContainer(name: string) {
    await withTimeout(docker.getContainer(name).remove({ force: true }), API_TIMEOUT_MS, "Container remove").catch(
      ignoreStatus(404, 409),
    );
  }

  /** Creates or starts the workspace container; returns it running. */
  async function ensureContainer(key: string): Promise<Docker.ContainerInspectInfo> {
    const name = resourceName(key);
    const spec = containerSpec({
      key,
      imageId: await imageId(),
      network: options.network,
      runtime,
      limits: options.limits,
    });
    let current = await inspect(name);
    const outdated = current && current.Config.Labels?.[LABELS.spec] !== spec.Labels?.[LABELS.spec];
    if (current && ((outdated && !busy(key)) || ["dead", "removing"].includes(current.State.Status))) {
      await removeContainer(name);
      bundleCache.delete(key);
      current = null;
    }
    if (!current) {
      await withTimeout(
        docker.createVolume({ Name: name, Labels: { [LABELS.sandbox]: "1", [LABELS.workspace]: key } }),
        API_TIMEOUT_MS,
        "Volume create",
      );
      // 409: created meanwhile by a concurrent open (another worker); use that one.
      await withTimeout(docker.createContainer(spec), API_TIMEOUT_MS, "Container create").catch(ignoreStatus(409));
      current = await inspect(name);
      if (!current) throw new Error(`Sandbox container ${name} disappeared after creation`);
    }
    if (current.State.Running && !current.State.Paused) return current;
    const container = docker.getContainer(current.Id);
    if (current.State.Paused) {
      await withTimeout(container.unpause(), API_TIMEOUT_MS, "Container unpause").catch(ignoreStatus(304, 409));
    } else {
      await withTimeout(container.start(), API_TIMEOUT_MS, "Container start").catch(ignoreStatus(304));
    }
    const started = await inspect(name);
    if (!started?.State.Running) {
      throw new Error(
        `Sandbox container ${name} did not start: ${started?.State.Error || started?.State.Status || "gone"}`,
      );
    }
    return started;
  }

  /**
   * Once per container start (and once after a worker restart): the MCP user's folders, the owner of
   * an MCP server's workspace, and HOME, which the volume starts with but may have lost since.
   */
  async function prepareUsers(spec: WorkspaceSpec, current: Docker.ContainerInspectInfo) {
    const instance = `${current.Id}/${current.State.StartedAt}`;
    if (preparedUsers.get(spec.key) === instance) return;
    const container = docker.getContainer(current.Id);
    const result = await runHelper(container, {
      cmd: ["/bin/sh", "-c", PREPARE_USERS_SCRIPT, "prepare", spec.owner ?? "sandbox"],
      user: ROOT_USER,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Preparing ${resourceName(spec.key)} failed: ${result.stderr.trim().slice(-500)}`);
    }
    // As the owner: root must not create or follow anything in a folder another user controls.
    await runHelper(container, { cmd: ["/bin/mkdir", "-p", PATHS.home], user: ownerUser(spec), timeoutMs: 15_000 });
    preparedUsers.set(spec.key, instance);
  }

  async function syncBundles(key: string, current: Docker.ContainerInspectInfo, spec: WorkspaceSpec) {
    const container = docker.getContainer(current.Id);
    const cached = bundleCache.get(key);
    let state: BundleState;
    if (cached && cached.containerId === current.Id && cached.startedAt === current.State.StartedAt) {
      state = cached.state;
    } else {
      const read = await runHelper(container, {
        cmd: ["/bin/cat", `${PATHS.bundles}/${BUNDLE_STATE_FILE}`],
        user: SANDBOX_USER,
        timeoutMs: 15_000,
      });
      state = read.exitCode === 0 ? parseBundleState(read.stdout) : {};
    }
    const plan = planBundleSync(state, spec.bundles ?? []);
    if (!planIsEmpty(plan)) {
      // Root owns the bundles tmpfs; names are validated, safe as arguments.
      const script = `set -e; cd ${PATHS.bundles}; for name in "$@"; do /bin/rm -rf -- "./$name"; done; /bin/tar -x --no-same-owner -f -`;
      const result = await runHelper(container, {
        cmd: ["/bin/sh", "-c", script, "sync", ...plan.remove],
        user: ROOT_USER,
        stdin: bundleTar(plan),
        timeoutMs: 60_000,
      });
      if (result.exitCode !== 0) {
        bundleCache.delete(key);
        throw new Error(`Syncing bundles into ${resourceName(key)} failed: ${result.stderr.trim().slice(-500)}`);
      }
    }
    bundleCache.set(key, { containerId: current.Id, startedAt: current.State.StartedAt, state: plan.state });
  }

  const prepare = (spec: WorkspaceSpec) =>
    serialize(spec.key, async () => {
      const current = await ensureContainer(spec.key);
      await prepareUsers(spec, current);
      const endpoint = endpointOf(current);
      if (!endpoint?.IPAddress) throw new Error(`${resourceName(spec.key)} has no address on ${options.network}`);
      addresses.set(spec.key, endpoint.IPAddress);
      await syncBundles(spec.key, current, spec);
      specs.set(spec.key, spec);
      touch(spec.key);
    });

  async function exec(spec: WorkspaceSpec, requested: ExecOptions): Promise<SandboxProcess> {
    const { key } = spec;
    const entry = usageOf(key);
    touch(key);
    const execOptions = requested.user === "mcp" ? mcpExecOptions(requested, spec.owner === "mcp") : requested;
    const start = async () => {
      entry.starting++;
      let child: SandboxProcess | null = null;
      try {
        const address = addresses.get(key);
        if (!address) throw new Error(`Workspace ${key} is not open`);
        child = await startProcess(docker.getContainer(resourceName(key)), address, proxy, execOptions, {
          onExit: () => {
            if (child) entry.active.delete(child);
            touch(key);
          },
        });
        entry.active.add(child);
        return child;
      } finally {
        entry.starting--;
      }
    };
    try {
      return await start();
    } catch (error) {
      // Paused or stopped by reap, or removed since open: bring it back (after a stop the bundles too,
      // the tmpfs is gone) and retry once. Docker answers 409 to an exec in a paused container.
      const status = statusOf(error);
      if (status !== 404 && status !== 409) throw error;
      await prepare(specs.get(key) ?? spec);
      return start();
    }
  }

  /**
   * Whether anything besides the container's own init runs in it (BACKGROUND_PROCESSES_SCRIPT). A
   * check that fails counts as yes: not pausing costs memory for a while, a wrong pause freezes work.
   */
  async function runsInBackground(container: Docker.Container): Promise<boolean> {
    try {
      const result = await runHelper(container, {
        cmd: ["/bin/sh", "-c", BACKGROUND_PROCESSES_SCRIPT],
        user: SANDBOX_USER,
        timeoutMs: 15_000,
      });
      return result.exitCode !== 0 || result.stdout.trim() !== "";
    } catch {
      return true;
    }
  }

  async function killAll(children: Iterable<SandboxProcess>) {
    await Promise.allSettled([...children].map((child) => withTimeout(child.kill(), 20_000, "kill")));
  }

  const backend: SandboxBackend = {
    isolation: runtime === "runsc" ? "gvisor" : "runc",

    pathsFor(key) {
      assertWorkspaceKey(key);
      return PATHS;
    },

    async open(spec) {
      assertWorkspaceKey(spec.key);
      for (const bundle of spec.bundles ?? []) assertBundle(bundle);
      await prepare(spec);
      const workspace: Workspace = {
        key: spec.key,
        paths: PATHS,
        exec: (execOptions) => exec(spec, execOptions),
      };
      return workspace;
    },

    async wake(key) {
      assertWorkspaceKey(key);
      const name = resourceName(key);
      // Every request to a live preview comes here: only unpausing waits for the workspace's lock.
      let current = await inspect(name);
      if (current?.State.Paused) {
        current = await serialize(key, async () => {
          const latest = await inspect(name);
          if (!latest?.State.Paused) return latest;
          await withTimeout(docker.getContainer(latest.Id).unpause(), API_TIMEOUT_MS, "Container unpause");
          return inspect(name);
        });
      }
      // A stopped container is not started: what ran in it is gone, so starting it would only cost resources.
      const address = runningAddress(current);
      if (address) touch(key);
      return address;
    },

    async remove(key) {
      assertWorkspaceKey(key);
      await serialize(key, async () => {
        await killAll(usage.get(key)?.active ?? []);
        const name = resourceName(key);
        await removeContainer(name);
        await withTimeout(docker.getVolume(name).remove(), API_TIMEOUT_MS, "Volume remove").catch(ignoreStatus(404));
        usage.delete(key);
        specs.delete(key);
        addresses.delete(key);
        bundleCache.delete(key);
        preparedUsers.delete(key);
      });
    },

    async list() {
      const result = await withTimeout(
        docker.listVolumes({ filters: { label: [`${LABELS.sandbox}=1`] } }),
        API_TIMEOUT_MS,
        "Volume list",
      );
      return (result.Volumes ?? []).flatMap((volume) => {
        const key = volume.Labels?.[LABELS.workspace];
        if (!key) return [];
        const usedAt = usage.get(key)?.usedAt;
        return [{ key, lastUsedAt: usedAt ? new Date(usedAt) : null }];
      });
    },

    async reap({ pauseAfterMs, stopAfterMs }) {
      const containers = await withTimeout(
        docker.listContainers({ filters: { label: [`${LABELS.sandbox}=1`], status: ["running", "paused"] } }),
        API_TIMEOUT_MS,
        "Container list",
      );
      const now = Date.now();
      /** What the container is due for: stop past `stopAfterMs`, pause (when running) past `pauseAfterMs`. */
      const due = (key: string, paused: boolean): "pause" | "stop" | null => {
        const entry = usageOf(key);
        entry.seenAt ??= now;
        if (busy(key)) return null;
        const idleMs = Date.now() - (entry.usedAt ?? entry.seenAt);
        if (idleMs >= stopAfterMs) return "stop";
        return !paused && idleMs >= pauseAfterMs ? "pause" : null;
      };
      const failures: string[] = [];
      for (const container of containers) {
        const key = container.Labels?.[LABELS.workspace];
        if (!key) continue;
        const paused = container.State === "paused";
        const action = due(key, paused);
        if (!action) continue;
        await serialize(key, async () => {
          if (due(key, paused) !== action) return; // used while waiting for the lock
          const target = docker.getContainer(container.Id);
          if (action === "pause") {
            // Pausing would freeze what the agent left running; the stop after the longer idle still applies.
            if (await runsInBackground(target)) return;
            await withTimeout(target.pause(), API_TIMEOUT_MS, "Container pause").catch(ignoreStatus(404, 409));
            return;
          }
          // Unpaused first: a signal cannot be delivered into a paused gVisor sandbox.
          if (paused) await withTimeout(target.unpause(), API_TIMEOUT_MS, "Container unpause").catch(ignoreStatus(404));
          await withTimeout(target.stop({ t: 5 }), API_TIMEOUT_MS, "Container stop").catch(ignoreStatus(304, 404));
          usageOf(key).seenAt = null;
        }).catch((error: unknown) => failures.push(`${resourceName(key)}: ${errorMessage(error)}`));
      }
      if (failures.length > 0) throw new Error(`Pausing or stopping idle sandboxes failed: ${failures.join("; ")}`);
    },

    async close() {
      await killAll([...usage.values()].flatMap((entry) => [...entry.active]));
      await proxy.close();
    },
  };
  return backend;
}

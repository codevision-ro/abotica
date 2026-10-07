/**
 * Docker backend: one long-lived container per workspace, its files in a named volume, commands
 * through exec. Containers start on first use, stop after being idle (reap) and are recreated when
 * their spec changes while nothing runs in them. The egress proxy runs in this process, on the
 * worker's address in the sandbox network.
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
  /** First time reap saw the container running: after a worker restart, running containers count as just used. */
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
      const networks = current.NetworkSettings.Networks ?? {};
      const endpoint = networks[options.network] ?? Object.values(networks).find((n) => n.NetworkID === networkId);
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
      // Stopped by reap or removed since open: bring it back (bundles too, the tmpfs is gone) and retry once.
      const status = statusOf(error);
      if (status !== 404 && status !== 409) throw error;
      await prepare(specs.get(key) ?? spec);
      return start();
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

    async addressOf(key) {
      assertWorkspaceKey(key);
      const current = await inspect(resourceName(key));
      if (!current?.State.Running || current.State.Paused) return null;
      const networks = current.NetworkSettings.Networks ?? {};
      const endpoint = networks[options.network] ?? Object.values(networks).find((n) => n.NetworkID === networkId);
      return endpoint?.IPAddress || null;
    },

    touch(key) {
      assertWorkspaceKey(key);
      touch(key);
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

    async reap({ stopAfterMs }) {
      const running = await withTimeout(
        docker.listContainers({ filters: { label: [`${LABELS.sandbox}=1`], status: ["running"] } }),
        API_TIMEOUT_MS,
        "Container list",
      );
      const now = Date.now();
      const idle = (key: string) => {
        const entry = usageOf(key);
        entry.seenAt ??= now;
        return !busy(key) && Date.now() - (entry.usedAt ?? entry.seenAt) >= stopAfterMs;
      };
      const failures: string[] = [];
      for (const container of running) {
        const key = container.Labels?.[LABELS.workspace];
        if (!key || !idle(key)) continue;
        await serialize(key, async () => {
          if (!idle(key)) return; // used while waiting for the lock
          await withTimeout(docker.getContainer(container.Id).stop({ t: 5 }), API_TIMEOUT_MS, "Container stop").catch(
            ignoreStatus(304, 404),
          );
          usageOf(key).seenAt = null;
        }).catch((error: unknown) => failures.push(`${resourceName(key)}: ${errorMessage(error)}`));
      }
      if (failures.length > 0) throw new Error(`Stopping idle sandboxes failed: ${failures.join("; ")}`);
    },

    async close() {
      await killAll([...usage.values()].flatMap((entry) => [...entry.active]));
      await proxy.close();
    },
  };
  return backend;
}

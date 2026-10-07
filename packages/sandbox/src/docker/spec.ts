/**
 * The container a Docker workspace runs in, as a pure function of its inputs. The spec hash is stored
 * as a label, so a container whose image, limits, runtime or network changed is recreated on open.
 */
import { createHash } from "node:crypto";
import type Docker from "dockerode";
import type { ContainerLimits, WorkspacePaths } from "../types";

/**
 * Folders of MCP server processes, outside the workspace volume. Their parent is owned by root, so
 * agent commands can neither plant nor swap them before a server starts. `home` and `tmp` are
 * private to the MCP user; `out` (`paths.mcpOutput`) is readable by agent commands.
 */
export const MCP_PATHS = {
  root: "/opt/abotica/mcp",
  home: "/opt/abotica/mcp/home",
  tmp: "/opt/abotica/mcp/tmp",
  out: "/opt/abotica/mcp/out",
} as const;

export const PATHS: WorkspacePaths = {
  workspace: "/workspace",
  bundles: "/opt/abotica/bundles",
  home: "/workspace/.home",
  mcpOutput: MCP_PATHS.out,
};

/** The `sandbox` user of the image. */
export const SANDBOX_USER = "1000:1000";
export const ROOT_USER = "0:0";
/**
 * The `mcp` user of the image, for stdio MCP servers. A different uid from the sandbox user's is
 * what keeps agent commands out of their /proc entries (environment, memory) and private folders.
 */
export const MCP_USER = "1001:1001";

export const LABELS = {
  sandbox: "abotica.sandbox",
  workspace: "abotica.workspace",
  spec: "abotica.spec",
} as const;

// Bump when containerSpec changes in a way existing containers must pick up.
const SPEC_VERSION = 2;

/**
 * What root needs to install system packages (dpkg sets owners and modes, apt drops to its own
 * user for downloads), and nothing more. Only root processes hold them: the sandbox user's
 * commands run without capabilities, and no-new-privileges keeps setuid binaries such as sudo
 * from raising them, so root is reachable only through an exec started as root.
 */
const ROOT_CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID"];

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertWorkspaceKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`Invalid workspace key: ${JSON.stringify(key)}`);
}

/** Container and volume name of a workspace. */
export const resourceName = (key: string) => `abotica-ws-${key}`;

export type ContainerSpecInput = {
  key: string;
  /** Image ID (not a tag), so a rebuilt image changes the hash. */
  imageId: string;
  network: string;
  runtime: "runc" | "runsc";
  limits: ContainerLimits;
};

export function specHash(input: ContainerSpecInput): string {
  const { imageId, network, runtime, limits } = input;
  const data = JSON.stringify([SPEC_VERSION, imageId, network, runtime, limits.memoryMb, limits.cpus, limits.pids]);
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function containerSpec(input: ContainerSpecInput): Docker.ContainerCreateOptions {
  const { key, imageId, network, runtime, limits } = input;
  assertWorkspaceKey(key);
  const name = resourceName(key);
  const memory = Math.round(limits.memoryMb * 1024 * 1024);
  // /tmp is memory-backed and counts against the memory limit.
  const tmpMb = Math.max(64, Math.floor(limits.memoryMb / 4));
  return {
    name,
    Image: imageId,
    Hostname: "sandbox",
    User: SANDBOX_USER,
    WorkingDir: PATHS.workspace,
    Env: [`HOME=${PATHS.home}`, "LANG=C.UTF-8", "TMPDIR=/tmp"],
    Labels: {
      [LABELS.sandbox]: "1",
      [LABELS.workspace]: key,
      [LABELS.spec]: specHash(input),
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    StopTimeout: 5,
    HostConfig: {
      NetworkMode: network,
      // Names never resolve to the outside: the internal network forwards no queries and this
      // upstream does not exist. The egress proxy is reached by IP.
      Dns: ["127.0.0.1"],
      PortBindings: {},
      PublishAllPorts: false,
      CapDrop: ["ALL"],
      CapAdd: ROOT_CAPABILITIES,
      SecurityOpt: ["no-new-privileges:true"],
      // Writable for root's package installs, which last until the container is recreated. The
      // system folders stay root-owned, so the sandbox user writes only the workspace and /tmp.
      ReadonlyRootfs: false,
      Tmpfs: {
        // Docker adds noexec unless told otherwise; builds (pip, npm) run scripts from /tmp.
        "/tmp": `rw,exec,nosuid,nodev,mode=1777,size=${tmpMb}m`,
        // Root-owned: the sandbox user reads bundles, only a root exec writes them. Emptied on restart.
        [PATHS.bundles]: "rw,exec,nosuid,nodev,mode=0755,size=256m",
      },
      Mounts: [{ Type: "volume", Source: name, Target: PATHS.workspace }],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.pids,
      IpcMode: "private",
      RestartPolicy: { Name: "no" },
      ...(runtime === "runsc" ? { Runtime: "runsc" } : {}),
    },
    NetworkingConfig: { EndpointsConfig: { [network]: {} } },
  };
}

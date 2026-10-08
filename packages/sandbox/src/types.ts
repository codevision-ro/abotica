/**
 * Contracts of the sandbox package. The backend runs commands for agents and stdio MCP servers in
 * isolated workspaces: one Docker container per workspace. Nothing here knows about the database,
 * projects or settings; core maps those onto these types.
 */
import type { Experimental_SandboxSession } from "ai";

/** The AI SDK sandbox interface the agent tools are written against. */
export type SandboxSession = Experimental_SandboxSession;

/**
 * Hosts a sandboxed process may connect to: patterns such as `pypi.org`, `*.github.com` or
 * `api.example.com:8443`, or "public" for any public address. An empty list means no network.
 * Private, loopback, link-local, multicast and cloud metadata addresses are refused in every case.
 */
export type Egress = readonly string[] | "public";

/** A read-only folder copied into the sandbox (a skill). Rewritten only when `hash` changes. */
export type Bundle = {
  /** Folder name: lowercase letters, digits and hyphens. */
  name: string;
  hash: string;
  files: { path: string; content: string | Uint8Array; executable?: boolean }[];
};

export type WorkspaceSpec = {
  /**
   * Stable id, safe as a folder, container and volume name: `project-<uuid>`, `conversation-<uuid>`
   * or `mcp-<slug>-<hash>`. Lowercase letters, digits and hyphens, at most 63 characters.
   */
  key: string;
  /**
   * Who owns the workspace's files: the sandbox user (agents, the default) or the MCP user (the own
   * workspace of a stdio MCP server, where no agent command runs).
   */
  owner?: "sandbox" | "mcp";
  /** Read-only folders available at `<paths.bundles>/<name>`; bundles not listed are removed. */
  bundles?: Bundle[];
};

/** Locations as seen by commands inside the sandbox. */
export type WorkspacePaths = {
  /** Working directory; its files persist between commands and runs. */
  workspace: string;
  /** Parent folder of the bundles: `<bundles>/<name>`. */
  bundles: string;
  /** HOME of sandboxed commands, inside the workspace so caches (pip, npm) persist. */
  home: string;
  /**
   * Parent of the folders stdio MCP servers keep their files in (`<mcpOutput>/<server>`) when they
   * run in a workspace of the sandbox user. Outside the workspace volume and written only by the MCP
   * user, so agent commands can read those files but neither change them nor swap the folders.
   */
  mcpOutput?: string;
};

export type ExecOptions = {
  /** Run with `bash -c`. */
  command: string;
  /**
   * Absolute, or relative to the workspace. Defaults to the workspace, except for the MCP user in a
   * workspace of the sandbox user: its private home, so nothing the agent left in the workspace is
   * read as the server's project config (.npmrc, pyproject.toml, node_modules).
   */
  cwd?: string;
  /** Added to the sandbox's base environment (PATH, HOME, LANG). Nothing from the host leaks in. */
  env?: Record<string, string>;
  egress: Egress;
  /** Kills the process after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** "pipe" keeps stdin open as a writable stream (file writes, stdio MCP servers). Default: empty stdin. */
  stdin?: "pipe";
  /**
   * "root" for system packages (apt-get). HOME is /root, and files it leaves under the workspace are
   * handed to the sandbox user afterwards. "mcp" for stdio MCP servers: their own user, so agent
   * commands in the same workspace cannot read their environment (secrets, egress token), memory or
   * private files; HOME and TMPDIR are private to it, PATH leaves out the sandbox user's folders, and
   * in a workspace the sandbox user owns it reads what that user leaves readable but writes nothing
   * there (its files go under `paths.mcpOutput`). Default: the sandbox user.
   */
  user?: "sandbox" | "root" | "mcp";
};

export type SandboxProcess = {
  /** Present when the process was started with `stdin: "pipe"`. */
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves when the process exits. `timedOut` is true when `timeoutMs` killed it. */
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  /** Terminates the process and its children. Idempotent. */
  kill(): Promise<void>;
};

export interface Workspace {
  readonly key: string;
  readonly paths: WorkspacePaths;
  exec(options: ExecOptions): Promise<SandboxProcess>;
}

export type ReapOptions = {
  /** Pause containers unused for this long: their processes (dev servers, databases) stay, frozen. */
  pauseAfterMs: number;
  /** Stop containers unused for this long, paused or not, counted from the last use. */
  stopAfterMs: number;
};

export interface SandboxBackend {
  /** Container runtime in use, shown on the status page. */
  readonly isolation: Isolation;
  /** Paths a workspace with this key will have, without creating anything (for the agent's instructions). */
  pathsFor(key: string): WorkspacePaths;
  /**
   * Creates the workspace if needed (Docker: volume and running container) and syncs its bundles.
   * Idempotent and safe to call concurrently for the same key.
   */
  open(spec: WorkspaceSpec): Promise<Workspace>;
  /**
   * The workspace container's address on the sandbox network, for the worker to reach a port of it
   * (live previews): a paused container is unpaused first, and the call counts as use. Null when it
   * is stopped or does not exist; a stopped container is not started.
   */
  wake(key: string): Promise<string | null>;
  /** Deletes a workspace: files, and for Docker its container and volume. No-op when missing. */
  remove(key: string): Promise<void>;
  /** Workspaces that exist, with the last time one was opened (null when unknown). */
  list(): Promise<{ key: string; lastUsedAt: Date | null }[]>;
  /** Pauses containers idle for `pauseAfterMs` and stops those idle for `stopAfterMs`; their volumes stay. */
  reap(options: ReapOptions): Promise<void>;
  /** Shuts down proxies and connections. */
  close(): Promise<void>;
}

export type Isolation = "gvisor" | "runc";

/** Resource limits of a Docker sandbox container. */
export type ContainerLimits = { memoryMb: number; cpus: number; pids: number };

export type DockerBackendOptions = {
  /** Docker Engine API endpoint, e.g. `tcp://docker-proxy:2375` or `unix:///var/run/docker.sock`. */
  host: string;
  /** Internal Docker network the sandbox containers join; the worker must be attached to it too. */
  network: string;
  /** Image the containers run, e.g. `abotica-sandbox:latest`. */
  image: string;
  /** "auto" uses gVisor (runsc) when the engine has it. */
  runtime: "auto" | "runc" | "runsc";
  limits: ContainerLimits;
};

export type BackendOptions = {
  /** Off in Settings > Sandbox: no backend is created. */
  enabled: boolean;
  /** Without it (SANDBOX_DOCKER_HOST unset) there is no sandbox. */
  docker?: DockerBackendOptions;
};

/** Result of probing Docker, stored by the worker and shown in Settings > Sandbox. */
export type SandboxStatus = {
  checkedAt: string;
  /** False when the sandbox is off in Settings > Sandbox. */
  enabled: boolean;
  /** Runtime of the running backend; null when there is none (off, or Docker unavailable). */
  isolation: Isolation | null;
  docker: {
    /** SANDBOX_DOCKER_HOST is set. */
    configured: boolean;
    available: boolean;
    /** Why it is not available, in English (shown as a technical detail). */
    reason?: string;
    gvisor: boolean;
    image?: string;
  };
  /** Tools found inside the sandbox, with their version line. */
  tools: { name: string; version: string | null }[];
};

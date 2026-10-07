/**
 * The AI SDK sandbox session over a workspace. The workspace is opened (and its packages installed)
 * on first use. File methods run `cat` / `sed` / `mkdir` inside the sandbox instead of touching the
 * host, so symlinks and permissions resolve as the sandboxed commands see them.
 */
import { Buffer } from "node:buffer";
import path from "node:path";
import { ensurePackages, type PackageLists } from "./packages";
import { collectBytes, collectText, runCommand, TIMEOUT_EXIT_CODE } from "./process";
import { shellQuote } from "./shell";
import type {
  Egress,
  ExecOptions,
  SandboxBackend,
  SandboxProcess,
  SandboxSession,
  Workspace,
  WorkspaceSpec,
} from "./types";

export type SandboxSessionOptions = {
  backend: SandboxBackend;
  /** Opened lazily on first use. */
  spec: WorkspaceSpec;
  /** Hosts the agent's commands may reach. */
  egress: Egress;
  /** Hosts package installs may reach, also those of root commands (apt-get). */
  setupEgress: Egress;
  packages?: PackageLists;
  /** Extra environment for every command. */
  env?: Record<string, string>;
  /** Returned as `session.description` for the agent's instructions. */
  description: string;
  /** Default and maximum run time of a command. */
  commandTimeoutMs: number;
  /** Aborting kills every process of this session. */
  signal?: AbortSignal;
  /** Called once after the workspace is open and its packages are installed. */
  onPrepare?: (workspace: Workspace) => Promise<void>;
};

/**
 * AI SDK process options plus a per-call timeout, capped at the session's `commandTimeoutMs`, and
 * the user to run as.
 */
export type SessionProcessOptions = Parameters<SandboxSession["run"]>[0] & {
  timeoutMs?: number;
  user?: ExecOptions["user"];
};

export type SessionRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command was killed by its timeout; `exitCode` is 124. */
  timedOut: boolean;
  /** A stream passed the output limit and was cut. */
  truncated: boolean;
};

type SessionProcess = Awaited<ReturnType<SandboxSession["spawn"]>> & {
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): Promise<void>;
};

/** A `SandboxSession` (assignable to it) with per-call timeouts, richer run results and lifecycle. */
export type ManagedSandboxSession = Omit<SandboxSession, "run" | "spawn"> & {
  readonly run: (options: SessionProcessOptions) => Promise<SessionRunResult>;
  readonly spawn: (options: SessionProcessOptions) => Promise<SessionProcess>;
  /** Opens (once) and returns the workspace. */
  workspace(): Promise<Workspace>;
  /** Whether anything opened the workspace yet. */
  readonly opened: boolean;
  /** Kills processes still running from this session. */
  close(): Promise<void>;
};

/** Exit code of the read script when the file does not exist. */
const MISSING_EXIT_CODE = 44;
const MAX_RUN_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export function createSandboxSession(options: SandboxSessionOptions): ManagedSandboxSession {
  const packages = options.packages ?? { python: [], node: [] };
  const processes = new Set<SandboxProcess>();
  let opening: Promise<Workspace> | undefined;
  let opened = false;
  let closed = false;

  const killAll = async () => {
    await Promise.all([...processes].map((proc) => proc.kill()));
  };
  const onSessionAbort = () => void killAll();
  options.signal?.addEventListener("abort", onSessionAbort, { once: true });

  const assertUsable = () => {
    options.signal?.throwIfAborted();
    if (closed) throw new Error("The sandbox session is closed.");
  };

  /** Signals that end a call: the call's own and the session's. */
  const callSignal = (signal?: AbortSignal) => {
    const signals = [signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  };
  const throwIfAborted = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    options.signal?.throwIfAborted();
  };

  const capTimeout = (timeoutMs?: number) =>
    timeoutMs === undefined ? options.commandTimeoutMs : Math.max(1, Math.min(timeoutMs, options.commandTimeoutMs));

  /** The workspace with every exec tracked, so close() and the session signal can kill it. */
  const tracked = (workspace: Workspace): Workspace => ({
    key: workspace.key,
    paths: workspace.paths,
    async exec(exec: ExecOptions) {
      assertUsable();
      const proc = await workspace.exec({ ...exec, signal: callSignal(exec.signal) });
      processes.add(proc);
      void proc.wait().finally(() => processes.delete(proc));
      if (closed) void proc.kill();
      return proc;
    },
  });

  const workspace = (): Promise<Workspace> => {
    assertUsable();
    if (!opening) {
      const current = (async () => {
        const ws = tracked(await options.backend.open(options.spec));
        opened = true;
        await ensurePackages(ws, packages, options.setupEgress, { signal: options.signal });
        await options.onPrepare?.(ws);
        return ws;
      })();
      opening = current;
      // A failed install or preparation is retried by the next call instead of sticking.
      current.catch(() => {
        if (opening === current) opening = undefined;
      });
    }
    return opening;
  };

  const resolvePath = (ws: Workspace, file: string) => {
    if (!file) throw new Error("A file path is required.");
    return path.posix.resolve(ws.paths.workspace, file);
  };

  /** Puts the workspace's venv and node_modules/.bin first on PATH when they exist. */
  const prelude = (ws: Workspace) => {
    const venv = path.posix.join(ws.paths.workspace, ".venv");
    const nodeModules = path.posix.join(ws.paths.workspace, ".abotica/node/node_modules");
    const python = shellQuote(`${venv}/bin/python`);
    const venvBin = shellQuote(`${venv}/bin`);
    const nodeBin = shellQuote(`${nodeModules}/.bin`);
    return (
      `if [ -x ${python} ]; then export VIRTUAL_ENV=${shellQuote(venv)} PATH=${venvBin}:"$PATH"; fi; ` +
      `if [ -d ${shellQuote(nodeModules)} ]; then export NODE_PATH=${shellQuote(nodeModules)} PATH=${nodeBin}:"$PATH"; fi; `
    );
  };

  const commandOptions = (ws: Workspace, call: SessionProcessOptions): ExecOptions => ({
    command: prelude(ws) + call.command,
    cwd: call.workingDirectory,
    env: { ...options.env, ...call.env },
    // Root is for installing system packages, so it reaches the package registries too.
    egress: call.user === "root" ? options.setupEgress : options.egress,
    timeoutMs: capTimeout(call.timeoutMs),
    signal: call.abortSignal,
    user: call.user,
  });

  /** Runs a file helper script; its output is never mixed with the prelude or the agent's env. */
  const fileExec = async (script: string, signal?: AbortSignal, stdin?: "pipe") => {
    const ws = await workspace();
    return ws.exec({ command: script, egress: [], timeoutMs: options.commandTimeoutMs, signal, stdin });
  };

  const fileError = (action: string, file: string, status: { exitCode: number; timedOut: boolean }, stderr: string) =>
    new Error(
      `Could not ${action} ${file}: ${status.timedOut ? "timed out" : stderr.trim() || `exit code ${status.exitCode}`}`,
    );

  /** Streams the output of a read script, or null when it reports the file missing. */
  const openRead = async (file: string, body: string, signal?: AbortSignal) => {
    const quoted = shellQuote(file);
    const proc = await fileExec(`if [ ! -e ${quoted} ]; then exit ${MISSING_EXIT_CODE}; fi\n${body}`, signal);
    const stderr = collectText(proc.stderr, MAX_ERROR_BYTES);
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    if (first.done) {
      const status = await proc.wait();
      throwIfAborted(signal);
      if (status.exitCode === MISSING_EXIT_CODE) return null;
      if (status.exitCode !== 0) throw fileError("read", file, status, (await stderr).text);
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (!first.done) controller.enqueue(first.value);
      },
      async pull(controller) {
        const next = first.done ? first : await reader.read();
        if (!next.done) return controller.enqueue(next.value);
        const status = await proc.wait();
        if (status.exitCode === 0) controller.close();
        else controller.error(fileError("read", file, status, (await stderr).text));
      },
      async cancel() {
        await reader.cancel();
        await proc.kill();
      },
    });
  };

  const readFile: ManagedSandboxSession["readFile"] = async ({ path: file, abortSignal }) => {
    const target = resolvePath(await workspace(), file);
    return openRead(target, `exec cat -- ${shellQuote(target)}`, abortSignal);
  };

  const readBytes = async (stream: ReadableStream<Uint8Array> | null) =>
    stream ? (await collectBytes(stream, Number.POSITIVE_INFINITY)).bytes : null;

  const writeStream = async (file: string, content: ReadableStream<Uint8Array>, signal?: AbortSignal) => {
    const target = resolvePath(await workspace(), file);
    const proc = await fileExec(
      `mkdir -p -- ${shellQuote(path.posix.dirname(target))} && exec cat > ${shellQuote(target)}`,
      signal,
      "pipe",
    );
    const stderr = collectText(proc.stderr, MAX_ERROR_BYTES);
    const stdout = collectText(proc.stdout, MAX_ERROR_BYTES);
    const piped = content.pipeTo(proc.stdin!).then(
      () => null,
      (error: unknown) => error,
    );
    const status = await proc.wait();
    const pipeError = await piped;
    await stdout;
    throwIfAborted(signal);
    if (status.exitCode !== 0) throw fileError("write", target, status, (await stderr).text);
    if (pipeError) throw pipeError;
  };

  const session: ManagedSandboxSession = {
    description: options.description,

    get opened() {
      return opened;
    },

    workspace,

    async run(call) {
      const ws = await workspace();
      const result = await runCommand(ws, { ...commandOptions(ws, call), maxOutputBytes: MAX_RUN_OUTPUT_BYTES });
      throwIfAborted(call.abortSignal);
      return result;
    },

    async spawn(call) {
      const ws = await workspace();
      const proc = await ws.exec(commandOptions(ws, call));
      return {
        stdout: proc.stdout,
        stderr: proc.stderr,
        async wait() {
          const status = await proc.wait();
          throwIfAborted(call.abortSignal);
          return { exitCode: status.timedOut ? TIMEOUT_EXIT_CODE : status.exitCode, timedOut: status.timedOut };
        },
        kill: () => proc.kill(),
      };
    },

    readFile,

    async readBinaryFile(read) {
      return readBytes(await readFile(read));
    },

    async readTextFile({ path: file, abortSignal, encoding = "utf-8", startLine, endLine }) {
      const target = resolvePath(await workspace(), file);
      const decoder = new TextDecoder(encoding);
      const quoted = shellQuote(target);
      let body = `exec cat -- ${quoted}`;
      if (startLine !== undefined || endLine !== undefined) {
        const start = Math.max(1, Math.floor(startLine ?? 1));
        const end = endLine === undefined ? undefined : Math.floor(endLine);
        if (end !== undefined && end < start) body = "exit 0";
        else body = `exec sed -n '${start},${end ?? "$"}p${end === undefined ? "" : `;${end}q`}' < ${quoted}`;
      }
      const bytes = await readBytes(await openRead(target, body, abortSignal));
      return bytes === null ? null : decoder.decode(bytes);
    },

    async writeFile({ path: file, content, abortSignal }) {
      await writeStream(file, content, abortSignal);
    },

    async writeBinaryFile({ path: file, content, abortSignal }) {
      await writeStream(file, bytesStream(content), abortSignal);
    },

    async writeTextFile({ path: file, content, abortSignal, encoding = "utf-8" }) {
      await writeStream(file, bytesStream(encodeText(content, encoding)), abortSignal);
    },

    async close() {
      closed = true;
      options.signal?.removeEventListener("abort", onSessionAbort);
      await killAll();
    },
  };
  return session;
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function encodeText(text: string, encoding: string): Uint8Array {
  const normalized = encoding.toLowerCase();
  if (normalized === "utf-8" || normalized === "utf8") return new TextEncoder().encode(text);
  if (Buffer.isEncoding(normalized)) return Buffer.from(text, normalized);
  throw new Error(`Unsupported encoding: ${encoding}`);
}

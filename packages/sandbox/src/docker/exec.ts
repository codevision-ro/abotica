/**
 * Processes in a workspace container, through the Engine exec API (hijacked stream, demuxed).
 *
 * Killing: an exec has no API to signal it, and stopping the container would hit every other
 * command. So each command gets a random marker in its environment and runs under `timeout`, which
 * makes itself a process group leader. kill() runs a second exec, as the same user (root, the
 * sandbox user or the MCP user: only it can read the environment of its processes), that finds the
 * processes carrying the marker in /proc and SIGKILLs each of them and the group they lead. Children
 * inherit both the environment and the group, so a child that clears its environment still dies with
 * the group, and one that starts its own session still carries the marker. The `timeout` duration is
 * a backstop a little past timeoutMs, for when the worker dies before its own timer fires.
 *
 * The image's PATH starts with folders the sandbox user can write (~/.npm-global/bin, ~/.local/bin).
 * Every exec this module issues itself (helpers, some as root, and the wrapper around agent commands)
 * therefore names its binaries by absolute path, and helpers also get a fixed PATH and HOME, so a
 * planted `sh` or `tar` is never what runs.
 */
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { PassThrough, Readable, Writable, type Duplex } from "node:stream";
import type Docker from "dockerode";
import type { ExecOptions, SandboxProcess } from "../types";
import type { EgressProxy } from "../egress/proxy";
import { withTimeout } from "./client";
import { demuxDockerStream } from "./demux";
import { MCP_PATHS, MCP_USER, PATHS, ROOT_USER, SANDBOX_USER } from "./spec";

const MARKER_ENV = "ABOTICA_EXEC";

const KILL_SCRIPT = `
marker="${MARKER_ENV}=$1"
for round in 1 2 3 4 5; do
  found=0
  for dir in /proc/[0-9]*; do
    pid=\${dir#/proc/}
    tr '\\0' '\\n' < "$dir/environ" 2>/dev/null | grep -qxF -- "$marker" || continue
    found=1
    if read -r stat < "$dir/stat" 2>/dev/null; then
      set -- \${stat##*) }
      [ "$3" = "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null
    fi
    kill -KILL "$pid" 2>/dev/null
  done
  [ "$found" = 0 ] && break
  sleep 0.1
done
exit 0
`;

/** Proxy variables for every tool we know of: curl, pip, uv, npm, git, Node's fetch (NODE_USE_ENV_PROXY). */
export function proxyEnv(url: string): Record<string, string> {
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  };
}

/**
 * Base environment of an MCP server process, under its `env`. The image's PATH starts with folders
 * the sandbox user writes (~/.npm-global/bin, ~/.local/bin), so it is replaced by one that starts
 * with the MCP user's own; HOME and TMPDIR are private to that user.
 */
export function mcpProcessEnv(home: string): Record<string, string> {
  return {
    PATH: `${home}/.npm-global/bin:${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: home,
    TMPDIR: MCP_PATHS.tmp,
    NPM_CONFIG_PREFIX: `${home}/.npm-global`,
    BASH_ENV: "",
    ENV: "",
  };
}

/**
 * An MCP server's exec. In its own workspace, which belongs to the MCP user, HOME stays on the volume
 * (package caches survive) and it starts in the workspace. In a workspace of the sandbox user, HOME
 * and the default working folder are its private home: npx, uvx and python -m resolve config and
 * modules from the working folder, and the agent writes the workspace.
 */
export function mcpExecOptions(options: ExecOptions, ownWorkspace: boolean): ExecOptions {
  const home = ownWorkspace ? PATHS.home : MCP_PATHS.home;
  return {
    ...options,
    cwd: options.cwd ?? (ownWorkspace ? PATHS.workspace : MCP_PATHS.home),
    env: { ...mcpProcessEnv(home), ...options.env },
  };
}

/** Environment of helper execs: nothing from the image that the sandbox user could influence. */
export const HELPER_ENV = ["PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/", "BASH_ENV=", "ENV="];

const toEnvList = (env: Record<string, string>) =>
  Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${value}`);

type RawExec = { stream: Duplex; exec: Docker.Exec };

/** Exec options of a helper: absolute binary, fixed environment, run from `/`. */
export function helperExecOptions(options: { cmd: string[]; user: string; stdin: boolean }): Docker.ExecCreateOptions {
  if (!options.cmd[0]?.startsWith("/")) throw new Error(`Helper commands need an absolute path: ${options.cmd[0]}`);
  return {
    Cmd: options.cmd,
    User: options.user,
    Env: HELPER_ENV,
    WorkingDir: "/",
    AttachStdin: options.stdin,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  };
}

/**
 * Prefix of a root command: when the shell exits, however it exits, files root left under the
 * workspace go to the sandbox user, who has to keep working on them.
 */
const ROOT_PRELUDE = `trap '/usr/bin/find ${PATHS.workspace} -xdev -user 0 -exec /usr/bin/chown -h ${SANDBOX_USER} {} + 2>/dev/null' EXIT\n`;

const userOf = (options: ExecOptions) =>
  options.user === "root" ? ROOT_USER : options.user === "mcp" ? MCP_USER : SANDBOX_USER;

/**
 * Exec options of a command: `bash -c` under `timeout` (see above), as the sandbox user unless
 * asked for root or the MCP user.
 */
export function processExecOptions(options: ExecOptions, env: Record<string, string>): Docker.ExecCreateOptions {
  const backstop = options.timeoutMs ? `${Math.ceil(options.timeoutMs / 1000) + 30}s` : "0";
  const root = options.user === "root";
  return {
    Cmd: [
      "/usr/bin/timeout",
      "-s",
      "KILL",
      backstop,
      "/bin/bash",
      "-c",
      root ? ROOT_PRELUDE + options.command : options.command,
    ],
    User: userOf(options),
    Env: toEnvList(root ? { ...env, HOME: "/root" } : env),
    WorkingDir: options.cwd ? posix.resolve(PATHS.workspace, options.cwd) : PATHS.workspace,
    AttachStdin: options.stdin === "pipe",
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  };
}

async function startRaw(container: Docker.Container, options: Docker.ExecCreateOptions): Promise<RawExec> {
  const stdin = !!options.AttachStdin;
  const exec = await withTimeout(container.exec(options), 30_000, "Creating an exec");
  const stream = await withTimeout(exec.start({ hijack: true, stdin, Tty: false }), 30_000, "Starting an exec");
  stream.on("error", () => {});
  return { stream, exec };
}

/**
 * Exit code from exec inspect, -1 when unknown. The exec may report Running for a moment after its
 * stream ends; null when it still runs after `waitMs` (the stream was cut, not the process).
 */
async function exitCodeOf(exec: Docker.Exec, waitMs = 2_000): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const info = await exec.inspect();
      if (!info.Running) return info.ExitCode ?? -1;
    } catch {
      return -1;
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const ended = (stream: Duplex) =>
  new Promise<void>((resolve) => {
    if (stream.destroyed || stream.readableEnded) return resolve();
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", () => resolve());
  });

/**
 * Runs a short helper command to completion and collects its output (bundle sync, state reads,
 * kills). Output is capped; helpers print little.
 */
export async function runHelper(
  container: Docker.Container,
  options: { cmd: string[]; user: string; stdin?: Buffer; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { stream, exec } = await startRaw(
    container,
    helperExecOptions({ cmd: options.cmd, user: options.user, stdin: !!options.stdin }),
  );
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const collect = (source: PassThrough) => {
    const chunks: Buffer[] = [];
    let size = 0;
    source.on("data", (chunk: Buffer) => {
      if (size < 1 << 20) chunks.push(chunk);
      size += chunk.length;
    });
    return () => Buffer.concat(chunks).toString("utf8");
  };
  const out = collect(stdout);
  const err = collect(stderr);
  demuxDockerStream(stream, stdout, stderr);
  if (options.stdin) stream.end(options.stdin);
  try {
    await withTimeout(ended(stream), options.timeoutMs ?? 60_000, `${options.cmd[0]} in the sandbox`);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return { exitCode: (await exitCodeOf(exec)) ?? -1, stdout: out(), stderr: err() };
}

export type ExecHooks = {
  /** Called once when the process has exited and its streams are done. */
  onExit(): void;
};

/**
 * Starts `bash -c command` (as the sandbox user, or root or the MCP user when asked) with egress
 * through a fresh proxy token, bound to `address` (the container's address on the sandbox network).
 */
export async function startProcess(
  container: Docker.Container,
  address: string,
  proxy: EgressProxy,
  options: ExecOptions,
  hooks: ExecHooks,
): Promise<SandboxProcess> {
  const marker = randomBytes(16).toString("hex");
  const grant = proxy.register(options.egress, address);
  const env = { ...options.env, ...proxyEnv(grant.url), [MARKER_ENV]: marker };
  const pipeStdin = options.stdin === "pipe";
  let raw: RawExec;
  try {
    raw = await startRaw(container, processExecOptions(options, env));
  } catch (error) {
    grant.revoke();
    hooks.onExit();
    throw error;
  }
  const { stream, exec } = raw;
  const stdout = new PassThrough({ highWaterMark: 256 * 1024 });
  const stderr = new PassThrough({ highWaterMark: 256 * 1024 });
  demuxDockerStream(stream, stdout, stderr);

  let timedOut = false;
  let killing: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;

  const kill = () => {
    killing ??= (async () => {
      try {
        // As the process's own user: only it can read their environment and signal them.
        await runHelper(container, {
          cmd: ["/bin/bash", "-c", KILL_SCRIPT, "kill", marker],
          user: userOf(options),
          timeoutMs: 15_000,
        });
      } catch {
        // Container gone or unreachable: closing the stream is all that is left.
      }
      await withTimeout(ended(stream), 5_000, "exit").catch(() => stream.destroy());
    })();
    return killing;
  };

  const onAbort = () => void kill();
  if (options.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      void kill();
    }, options.timeoutMs);
  }
  if (options.signal?.aborted) void kill();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = (async () => {
    await ended(stream);
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    grant.revoke();
    let exitCode = await exitCodeOf(exec);
    if (exitCode === null) {
      // The connection dropped (worker side, docker-proxy timeout) while the process lives on:
      // nobody reads its output anymore, so it must not keep running.
      await kill();
      exitCode = (await exitCodeOf(exec, 5_000)) ?? -1;
    }
    hooks.onExit();
    return { exitCode: timedOut ? 124 : exitCode, timedOut };
  })();

  return {
    stdin: pipeStdin ? (Writable.toWeb(stream) as WritableStream<Uint8Array>) : null,
    stdout: Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(stderr) as unknown as ReadableStream<Uint8Array>,
    wait: () => done,
    kill,
  };
}

/**
 * For tests only: a workspace whose commands run with bash in a local folder, so scripts meant for
 * the sandbox run for real. Nothing is isolated; the environment is PATH plus `env`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ExecOptions, SandboxProcess, Workspace } from "@abotica/sandbox";

export function bashWorkspace(dir: string, env: Record<string, string> = {}): Workspace {
  return {
    key: "test",
    paths: { workspace: dir, bundles: path.join(dir, ".bundles"), home: env.HOME ?? dir },
    async exec(options: ExecOptions): Promise<SandboxProcess> {
      const child = spawn("bash", ["-c", options.command], {
        cwd: options.cwd ? path.resolve(dir, options.cwd) : dir,
        env: { PATH: process.env.PATH!, ...env, ...options.env },
        stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const exited = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) =>
        child.on("close", (code) => resolve({ exitCode: code ?? 1, timedOut: false })),
      );
      return {
        stdin: child.stdin ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>) : null,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => void child.kill("SIGKILL"),
      };
    },
  };
}

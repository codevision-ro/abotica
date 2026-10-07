/**
 * Declared packages, installed inside the workspace: Python into `.venv`, Node into
 * `.abotica/node`. A marker with the hash of the lists skips work that is already done.
 */
import { createHash } from "node:crypto";
import { runCommand } from "./process";
import { shellQuote } from "./shell";
import type { Egress, Workspace } from "./types";

export type PackageLists = { python: string[]; node: string[] };

const MARKER = ".abotica/packages.json";
const UP_TO_DATE = "__abotica_packages_up_to_date__";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_CHARS = 4000;

/** Stable across order and duplicates; bump the version when the install layout changes. */
export function packagesHash(packages: PackageLists): string {
  const normalized = {
    v: 1,
    python: [...new Set(packages.python)].sort(),
    node: [...new Set(packages.node)].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** The install script, run with the workspace as working directory. Exported for tests. */
export function installScript(packages: PackageLists): string {
  const marker = JSON.stringify({ hash: packagesHash(packages) });
  const lines = [
    `if [ "$(cat ${MARKER} 2>/dev/null)" = ${shellQuote(marker)} ]; then echo ${UP_TO_DATE}; exit 0; fi`,
    "set -e",
    "mkdir -p .abotica",
  ];
  if (packages.python.length) {
    const specs = packages.python.map(shellQuote).join(" ");
    lines.push(
      "if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi",
      "if command -v uv >/dev/null 2>&1; then",
      `  uv pip install --python .venv/bin/python ${specs}`,
      "else",
      `  .venv/bin/pip install --disable-pip-version-check --progress-bar off ${specs}`,
      "fi",
    );
  }
  if (packages.node.length) {
    const specs = packages.node.map(shellQuote).join(" ");
    lines.push(`npm install --prefix .abotica/node --no-audit --no-fund --no-progress ${specs}`);
  }
  lines.push(`printf '%s' ${shellQuote(marker)} > ${MARKER}`);
  return `{\n${lines.join("\n")}\n} 2>&1`;
}

/**
 * Installs the declared packages unless the marker says they already are. Packages removed from
 * the lists stay installed until the workspace is reset. Throws with the tail of the log on failure.
 */
export async function ensurePackages(
  workspace: Workspace,
  packages: PackageLists,
  egress: Egress,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ installed: boolean; log: string }> {
  if (!packages.python.length && !packages.node.length) return { installed: false, log: "" };
  return serialized(workspace.key, () => install(workspace, packages, egress, options));
}

/**
 * Installs into one workspace run one at a time: two runs opening it with a new list would
 * otherwise run venv, pip and npm over each other. The worker is the only process installing.
 */
const pending = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  pending.set(key, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (pending.get(key) === next) pending.delete(key);
    });
  return next;
}

async function install(
  workspace: Workspace,
  packages: PackageLists,
  egress: Egress,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ installed: boolean; log: string }> {
  options.signal?.throwIfAborted();
  const result = await runCommand(workspace, {
    command: installScript(packages),
    egress,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  options.signal?.throwIfAborted();
  const log = result.stdout;
  if (result.exitCode === 0 && log.trim() === UP_TO_DATE) return { installed: false, log: "" };
  if (result.exitCode !== 0) {
    const reason = result.timedOut ? "timed out" : `failed with exit code ${result.exitCode}`;
    throw new Error(`Package install ${reason}:\n${log.slice(-LOG_TAIL_CHARS)}`);
  }
  return { installed: true, log };
}

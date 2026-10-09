/**
 * Creates the Docker backend when the sandbox is on and Docker can run it, and describes the result
 * for the status page. Never throws: an unavailable backend is a status, not an error.
 */
import { createDockerBackend } from "./docker/backend";
import { detectDocker } from "./docker/detect";
import { runCommand } from "./process";
import type { BackendOptions, SandboxBackend, SandboxStatus } from "./types";

const PROBE_KEY = "probe";
const PROBE_COMMAND_TIMEOUT_MS = 10_000;
const PROBE_TOTAL_TIMEOUT_MS = 15_000;

/** Tools listed on the status page, with the command printing each one's version. */
const PROBES: { name: string; command: string }[] = [
  { name: "python3", command: "python3 --version" },
  { name: "pip", command: "python3 -m pip --version" },
  { name: "uv", command: "uv --version" },
  { name: "node", command: "node --version" },
  { name: "npm", command: "npm --version" },
  // pnpm and yarn come through corepack, which downloads them on first use.
  { name: "corepack", command: "corepack --version" },
  { name: "php", command: "php --version" },
  { name: "composer", command: "composer --version" },
  { name: "gcc", command: "gcc --version" },
  { name: "git", command: "git --version" },
  { name: "curl", command: "curl --version" },
  { name: "jq", command: "jq --version" },
  { name: "yq", command: "yq --version" },
  { name: "rg", command: "rg --version" },
  { name: "fd", command: "fd --version" },
  { name: "tree", command: "tree --version" },
  { name: "sqlite3", command: "sqlite3 --version" },
  { name: "psql", command: "psql --version" },
  { name: "mysql", command: "mysql --version" },
  { name: "ffmpeg", command: "ffmpeg -version" },
  { name: "convert", command: "convert --version" },
  { name: "pdftotext", command: "pdftotext -v" },
  { name: "pandoc", command: "pandoc --version" },
  { name: "zip", command: "zip -v | grep -m1 -i 'this is zip'" },
  { name: "unzip", command: "unzip -v" },
];

export async function createBackend(
  options: BackendOptions,
): Promise<{ backend: SandboxBackend | null; status: SandboxStatus }> {
  const status: SandboxStatus = {
    checkedAt: new Date().toISOString(),
    enabled: options.enabled,
    isolation: null,
    docker: await dockerStatus(options),
    tools: [],
  };
  if (!options.enabled || !options.docker || !status.docker.available) return { backend: null, status };

  let backend: SandboxBackend;
  try {
    backend = await createDockerBackend(options.docker);
  } catch (error) {
    status.docker = { ...status.docker, available: false, reason: errorMessage(error) };
    return { backend: null, status };
  }
  status.isolation = backend.isolation;
  status.tools = await probeTools(backend);
  return { backend, status };
}

async function dockerStatus(options: BackendOptions): Promise<SandboxStatus["docker"]> {
  if (!options.docker) {
    return { configured: false, available: false, reason: "SANDBOX_DOCKER_HOST is not set.", gvisor: false };
  }
  try {
    const { configured, available, reason, gvisor, image } = await detectDocker(options.docker);
    // Only the documented fields: the status is stored as JSON and shown as is.
    return { configured, available, gvisor, ...(reason ? { reason } : {}), ...(image ? { image } : {}) };
  } catch (error) {
    return { configured: true, available: false, reason: errorMessage(error), gvisor: false };
  }
}

/** Version line of each tool inside the sandbox, run in parallel in a throwaway workspace. */
async function probeTools(backend: SandboxBackend): Promise<SandboxStatus["tools"]> {
  const signal = AbortSignal.timeout(PROBE_TOTAL_TIMEOUT_MS);
  try {
    const workspace = await backend.open({ key: PROBE_KEY });
    return await Promise.all(
      PROBES.map(async ({ name, command }) => {
        try {
          const result = await runCommand(workspace, {
            command,
            egress: [],
            timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
            signal,
            maxOutputBytes: 4096,
          });
          return { name, version: versionLine(result) };
        } catch {
          return { name, version: null };
        }
      }),
    );
  } catch {
    return PROBES.map(({ name }) => ({ name, version: null }));
  } finally {
    await backend.remove(PROBE_KEY).catch(() => {});
  }
}

/**
 * First output line of a version command (stdout, else stderr). Some tools exit non-zero after printing their version
 * (`pdftotext -v` on older poppler), so a line with a version number counts unless the command
 * was missing (127), not executable (126) or timed out.
 */
function versionLine(result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }): string | null {
  const firstLine = (text: string) =>
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 200);
  // stdout first: wrappers such as macOS's xcrun shims print warnings on stderr.
  const line = firstLine(result.stdout) ?? firstLine(result.stderr);
  if (!line || result.timedOut) return null;
  if (result.exitCode === 0) return line;
  return [124, 126, 127].includes(result.exitCode) || !/\d+\.\d+/.test(line) ? null : line;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

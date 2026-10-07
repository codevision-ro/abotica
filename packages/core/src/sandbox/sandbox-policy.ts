/**
 * Sandbox policy: network modes, package lists and their validation. Pure and client-safe, so the
 * settings, project and MCP forms validate with the same rules as the server.
 */
import type { NetworkMode, NetworkPolicy, SandboxPackages, SandboxPolicy } from "@abotica/db";
import { UserError } from "@abotica/i18n";

export type { NetworkMode, NetworkPolicy, SandboxPackages, SandboxPolicy };

/** Display order: least to most open. */
export const NETWORK_MODES = ["off", "packages", "custom", "full"] as const satisfies readonly NetworkMode[];

/**
 * Hosts the `packages` and `custom` modes allow, so installs work: pip and uv (PyPI), npm, pnpm and
 * yarn (the npm registry, and Yarn's own for corepack), Composer (Packagist, which serves most
 * packages as GitHub archives) and apt for root commands (Debian).
 */
export const PACKAGE_REGISTRY_HOSTS = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "repo.packagist.org",
  "packagist.org",
  "api.github.com",
  "codeload.github.com",
  "deb.debian.org",
] as const;

export const SANDBOX_RUNTIMES = ["auto", "runc", "runsc"] as const;
export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];

export type SandboxSettings = {
  /** Agents get Docker workspaces; off, they work without one. */
  enabled: boolean;
  /** Policy of chats without a project and of projects that follow the default. */
  defaults: SandboxPolicy;
  /** Longest a single command may run, in seconds. */
  commandTimeoutSec: number;
  /** Container runtime ("auto" uses gVisor when installed). */
  runtime: SandboxRuntime;
  /** Memory limit per workspace container. */
  memoryMb: number;
  /** CPU limit per workspace container. */
  cpus: number;
};

export const SANDBOX_LIMITS = {
  commandTimeoutSec: { min: 10, max: 3600 },
  memoryMb: { min: 256, max: 65_536 },
  cpus: { min: 0.25, max: 64 },
  domains: 100,
  packages: 50,
} as const;

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  network: { mode: "packages", domains: [] },
  packages: { python: [], node: [] },
};

/** Stdio MCP servers usually call their own API, so they start with any public host allowed. */
export const DEFAULT_MCP_NETWORK: NetworkPolicy = { mode: "full", domains: [] };

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: true,
  defaults: DEFAULT_SANDBOX_POLICY,
  commandTimeoutSec: 300,
  runtime: "auto",
  memoryMb: 2048,
  cpus: 2,
};

/**
 * Hosts a sandboxed process may reach under a policy: a list of host patterns, or "public" for any
 * public host. Private and metadata addresses are refused by the sandbox in every mode.
 */
export function egressFor(network: NetworkPolicy): readonly string[] | "public" {
  switch (network.mode) {
    case "off":
      return [];
    case "packages":
      return PACKAGE_REGISTRY_HOSTS;
    case "custom":
      return [...new Set([...PACKAGE_REGISTRY_HOSTS, ...network.domains])];
    case "full":
      return "public";
  }
}

/** Package installs always reach the registries, even when the agent's own commands are offline. */
export function setupEgressFor(network: NetworkPolicy): readonly string[] | "public" {
  const egress = egressFor(network);
  return egress === "public" ? egress : [...new Set([...PACKAGE_REGISTRY_HOSTS, ...egress])];
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}(:\d{1,5})?$/;

/** `example.com`, `*.example.com` or `api.example.com:8443`; lowercase, no scheme or path. */
export function isDomainPattern(value: string): boolean {
  if (!DOMAIN_RE.test(value) || value.length > 253) return false;
  const port = value.split(":")[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

/** Accepts a pasted URL or host and returns the host pattern, or null when it is not one. */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return isDomainPattern(value) ? value : null;
}

const PYTHON_SPEC_RE =
  /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(\[[A-Za-z0-9._,-]+\])?((==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+(,(==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+)*)?$/;
const NODE_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~*+_<>=-]+)?$/;

/** A pip requirement (`pandas`, `pandas==2.2.3`, `uvicorn[standard]>=0.30`) or npm spec (`sharp@0.34`). */
export function isPackageSpec(kind: keyof SandboxPackages, value: string): boolean {
  return value.length <= 200 && (kind === "python" ? PYTHON_SPEC_RE : NODE_SPEC_RE).test(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Validates a network policy from a form or an agent; throws a UserError naming the bad entry. */
export function parseNetworkPolicy(input: unknown): NetworkPolicy {
  if (!isRecord(input)) throw new UserError("sandbox.errors.invalidPolicy");
  const mode = input.mode;
  if (typeof mode !== "string" || !(NETWORK_MODES as readonly string[]).includes(mode)) {
    throw new UserError("sandbox.errors.invalidPolicy");
  }
  const domains: string[] = [];
  for (const raw of stringList(input.domains)) {
    const domain = normalizeDomain(raw);
    if (!domain) throw new UserError("sandbox.errors.invalidDomain", { domain: raw });
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > SANDBOX_LIMITS.domains) {
    throw new UserError("sandbox.errors.tooManyDomains", { max: SANDBOX_LIMITS.domains });
  }
  // Domains only matter in custom mode; keeping them lets the user switch modes and back.
  return { mode: mode as NetworkMode, domains };
}

/** Validates package lists; throws a UserError naming the bad entry. */
export function parsePackages(input: unknown): SandboxPackages {
  const out: SandboxPackages = { python: [], node: [] };
  if (!isRecord(input)) return out;
  for (const kind of ["python", "node"] as const) {
    for (const raw of stringList(input[kind])) {
      const spec = raw.trim();
      if (!spec) continue;
      if (!isPackageSpec(kind, spec)) throw new UserError("sandbox.errors.invalidPackage", { name: spec });
      if (!out[kind].includes(spec)) out[kind].push(spec);
    }
    if (out[kind].length > SANDBOX_LIMITS.packages) {
      throw new UserError("sandbox.errors.tooManyPackages", { max: SANDBOX_LIMITS.packages });
    }
  }
  return out;
}

export function parseSandboxPolicy(input: unknown): SandboxPolicy {
  if (!isRecord(input)) throw new UserError("sandbox.errors.invalidPolicy");
  return { network: parseNetworkPolicy(input.network), packages: parsePackages(input.packages) };
}

const clamp = (value: unknown, { min, max }: { min: number; max: number }, fallback: number) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Validates the Settings > Sandbox form; numbers are clamped to their limits. */
export function parseSandboxSettings(input: unknown): SandboxSettings {
  if (!isRecord(input)) throw new UserError("sandbox.errors.invalidPolicy");
  const d = DEFAULT_SANDBOX_SETTINGS;
  const runtime = (SANDBOX_RUNTIMES as readonly unknown[]).includes(input.runtime)
    ? (input.runtime as SandboxRuntime)
    : d.runtime;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : d.enabled,
    defaults: parseSandboxPolicy(input.defaults),
    commandTimeoutSec: Math.round(clamp(input.commandTimeoutSec, SANDBOX_LIMITS.commandTimeoutSec, d.commandTimeoutSec)),
    runtime,
    memoryMb: Math.round(clamp(input.memoryMb, SANDBOX_LIMITS.memoryMb, d.memoryMb)),
    cpus: clamp(input.cpus, SANDBOX_LIMITS.cpus, d.cpus),
  };
}

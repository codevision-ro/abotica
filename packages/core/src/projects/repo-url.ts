/**
 * Git repository addresses: parsing what the user pastes, and the URLs derived from a stored repo.
 * Pure and client-safe, so the repo form shows the same result the server stores.
 */
import { normalizeDomain } from "../sandbox/sandbox-policy";

export type RepoProvider = "github" | "gitlab";

export const REPO_PROVIDERS = ["github", "gitlab"] as const satisfies readonly RepoProvider[];

/** Where a repo lives: a lowercase host (with a port other than 443) and its path without `.git`. */
export type RepoLocation = { host: string; path: string };

/** Hosts whose provider is known; any other host is a self-hosted GitHub Enterprise or GitLab. */
const KNOWN_HOSTS: Record<string, RepoProvider> = { "github.com": "github", "gitlab.com": "gitlab" };

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The repository a pasted address points at: an HTTPS clone or browser URL (`/tree/main` and
 * GitLab's `/-/...` pages included) or an SSH address (`git@host:owner/repo.git`). GitHub paths are
 * `owner/repo`; GitLab ones may nest groups. Null when it is not a repository address.
 */
export function parseRepoUrl(input: string): RepoLocation | null {
  const value = input.trim();
  let host: string;
  let rest: string;
  const scp = /^[A-Za-z0-9_.-]+@([^:/]+):(?!\/)(.+)$/.exec(value);
  if (scp) {
    // An SSH address names the SSH host; cloning goes over HTTPS on the default port.
    host = scp[1]!;
    rest = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    // Cloning always uses HTTPS, so a plain HTTP address would point at a server that cannot work.
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return null;
    host = url.protocol === "https:" ? url.host : url.hostname;
    rest = url.pathname;
  }
  const normalizedHost = normalizeDomain(host);
  if (!normalizedHost || normalizedHost.startsWith("*.")) return null;

  let segments = rest.split("/").filter(Boolean);
  const dash = segments.indexOf("-");
  if (dash !== -1) segments = segments.slice(0, dash);
  if (KNOWN_HOSTS[normalizedHost] === "github") segments = segments.slice(0, 2);
  const last = segments.at(-1);
  if (last?.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -4);
  if (segments.length < 2 || !segments.every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) return null;
  return { host: normalizedHost, path: segments.join("/") };
}

/** The provider a host is known to belong to, or null for a self-hosted one the user has to name. */
export const providerOfHost = (host: string): RepoProvider | null => KNOWN_HOSTS[host] ?? null;

/** What git clones and authenticates against. */
export const repoCloneUrl = (repo: RepoLocation) => `https://${repo.host}/${repo.path}.git`;

/** The repository's page on the provider. */
export const repoWebUrl = (repo: RepoLocation) => `https://${repo.host}/${repo.path}`;

/** Folder a repo gets in the workspace unless the user picks another: its last path segment. */
export function defaultRepoName(path: string): string {
  const name = (path.split("/").at(-1) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return name || "repo";
}

/** A folder name under `repos/`: lowercase letters, digits, dots, hyphens and underscores. */
export const isRepoName = (name: string) => REPO_NAME_RE.test(name);

/** Base URL of the provider's REST API for a host. */
export function repoApiBase(provider: RepoProvider, host: string): string {
  if (provider === "gitlab") return `https://${host}/api/v4`;
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/**
 * Where the user creates a token for the repo. On GitHub the form comes pre-filled (name, owner,
 * Contents and Pull requests read and write, Actions and Commit statuses read for following the
 * checks of pull requests); the user still picks the repository.
 */
export function repoTokenUrl(provider: RepoProvider, repo: RepoLocation, label: string): string {
  if (provider === "gitlab") return `${repoWebUrl(repo)}/-/settings/access_tokens`;
  const query = new URLSearchParams({
    name: label.slice(0, 40),
    description: `Abotica agents: ${repo.path}`,
    target_name: repo.path.split("/")[0]!,
    contents: "write",
    pull_requests: "write",
    actions: "read",
    statuses: "read",
  });
  return `https://${repo.host}/settings/personal-access-tokens/new?${query}`;
}

/** The settings page where the default branch gets protected. */
export const repoProtectionUrl = (provider: RepoProvider, repo: RepoLocation) =>
  provider === "gitlab" ? `${repoWebUrl(repo)}/-/settings/repository` : `${repoWebUrl(repo)}/settings/branches`;

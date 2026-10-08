/**
 * The HTTP client for the GitHub and GitLab REST APIs, with a repo's token. Used by the repo checks and
 * pull requests (repo-api.ts) and by following pull requests afterwards (pull-request-api.ts).
 */
import { UserError } from "@abotica/i18n";
import { z } from "zod";
import { type RepoLocation, type RepoProvider, repoApiBase } from "./repo-url";

export const TIMEOUT_MS = 20_000;

export type RepoAccess = RepoLocation & { provider: RepoProvider; token: string };

export type ApiResponse = { status: number; body: unknown };

function headers(repo: RepoAccess): Record<string, string> {
  const auth: Record<string, string> =
    repo.provider === "github"
      ? {
          authorization: `Bearer ${repo.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        }
      : { "private-token": repo.token };
  return { ...auth, "user-agent": "abotica" };
}

/** A request to the provider's API with the token; `redirect` is refused unless the caller handles it. */
export async function request(
  repo: RepoAccess,
  method: string,
  endpoint: string,
  init: { body?: unknown; redirect?: "error" | "manual" } = {},
): Promise<Response> {
  const head = headers(repo);
  if (init.body !== undefined) head["content-type"] = "application/json";
  try {
    return await fetch(`${repoApiBase(repo.provider, repo.host)}${endpoint}`, {
      method,
      headers: head,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: init.redirect ?? "error",
    });
  } catch {
    throw new UserError("repos.errors.unreachable", { host: repo.host });
  }
}

export async function call(repo: RepoAccess, method: string, endpoint: string, body?: unknown): Promise<ApiResponse> {
  const res = await request(repo, method, endpoint, { body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (a proxy's error page): kept as text for the message.
  }
  return { status: res.status, body: parsed };
}

/** The body in the shape read below, or null when the provider sent something else. */
export function parseBody<T>(response: ApiResponse, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(response.body);
  return parsed.success ? parsed.data : null;
}

export const unexpectedBody = (response: ApiResponse) => `HTTP ${response.status}: unexpected response`;

/** The provider's own explanation of a failed call, for the agent. */
export function apiMessage({ status, body }: ApiResponse): string {
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; errors?: unknown; error?: unknown };
    const details = Array.isArray(b.errors)
      ? b.errors.map((e) => (typeof e === "string" ? e : ((e as { message?: string }).message ?? ""))).filter(Boolean)
      : [];
    const message = [b.message, b.error, ...details]
      .flatMap((m) => (Array.isArray(m) ? m : [m]))
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    if (message.length) return `HTTP ${status}: ${message.join("; ")}`;
  }
  return `HTTP ${status}${typeof body === "string" && body ? `: ${body.slice(0, 300)}` : ""}`;
}

export const encodePath = (path: string) => encodeURIComponent(path);
export const githubRepo = (repo: RepoAccess) => `/repos/${repo.path}`;
export const gitlabProject = (repo: RepoAccess) => `/projects/${encodePath(repo.path)}`;

/** The body of a successful read, or null: callers degrade instead of failing. */
export const okBody = (r: ApiResponse) => (r.status === 200 ? r.body : null);

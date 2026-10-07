/**
 * A project's git repositories. Each one is checked against the provider when it is added or its
 * token changes, and agents get it cloned in their workspace (see agents/repo-workspace.ts).
 */
import { db, projectRepos } from "@abotica/db";
import { and, asc, eq, getTableColumns } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { audit } from "../platform/audit";
import { isUniqueViolation } from "../infra/db-errors";
import { checkRepo, type RepoAccess } from "./repo-api";
import {
  defaultRepoName,
  isRepoName,
  parseRepoUrl,
  providerOfHost,
  type RepoProvider,
  repoCloneUrl,
  repoWebUrl,
} from "./repo-url";
import { decrypt, encrypt } from "../platform/vault";

type RepoRow = typeof projectRepos.$inferSelect;

/** A repo as the app shows it: everything but the token. */
export type ProjectRepo = Omit<RepoRow, "token">;

/** A repo as a run uses it, with its token decrypted. */
export type RunRepo = ProjectRepo & { token: string; cloneUrl: string; webUrl: string };

/** A copy without the token: rows and columns that leave this module never carry it. */
function omitToken<T extends { token: unknown }>(value: T): Omit<T, "token"> {
  const copy: Partial<T> = { ...value };
  delete copy.token;
  return copy as Omit<T, "token">;
}

const publicColumns = omitToken(getTableColumns(projectRepos));

/** Characters of the token shown to tell tokens apart. */
const TOKEN_HINT_LENGTH = 4;

const tokenHint = (token: string) => token.slice(-TOKEN_HINT_LENGTH);

export function listProjectRepos(projectId: string): Promise<ProjectRepo[]> {
  return db
    .select(publicColumns)
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .orderBy(asc(projectRepos.name));
}

/** The project's repos with their tokens, for a run. A token that no longer decrypts leaves its repo out. */
export async function runRepos(projectId: string): Promise<RunRepo[]> {
  const rows = await db
    .select()
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .orderBy(asc(projectRepos.name));
  return rows.flatMap((row) => {
    try {
      return [{ ...row, token: decrypt(row.token), cloneUrl: repoCloneUrl(row), webUrl: repoWebUrl(row) }];
    } catch (error) {
      console.error(`[repos] the token of ${row.host}/${row.path} cannot be decrypted:`, error);
      return [];
    }
  });
}

async function repoRow(id: string, projectId: string): Promise<RepoRow> {
  const [row] = await db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.id, id), eq(projectRepos.projectId, projectId)));
  if (!row) throw new UserError("repos.errors.repoNotFound");
  return row;
}

export type AddRepoInput = {
  projectId: string;
  /** What the user pasted: a clone, browser or SSH address. */
  url: string;
  token: string;
  /** Required for a self-hosted host; ignored for github.com and gitlab.com. */
  provider?: RepoProvider | null;
  /** Folder under `repos/`; defaults to the repository's name. */
  name?: string | null;
};

/** Adds a repo after checking with the provider that the token can reach it and push to it. */
export async function addProjectRepo(input: AddRepoInput, opts: { actor?: string } = {}): Promise<ProjectRepo> {
  const location = parseRepoUrl(input.url);
  if (!location) throw new UserError("repos.errors.invalidUrl");
  const provider = providerOfHost(location.host) ?? input.provider;
  if (!provider) throw new UserError("repos.errors.providerRequired");
  const name = input.name?.trim() || defaultRepoName(location.path);
  if (!isRepoName(name)) throw new UserError("repos.errors.invalidName");
  const token = input.token.trim();

  const existing = await db
    .select({ name: projectRepos.name, host: projectRepos.host, path: projectRepos.path })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, input.projectId));
  if (existing.some((r) => r.host === location.host && r.path === location.path)) {
    throw new UserError("repos.errors.alreadyAdded");
  }
  if (existing.some((r) => r.name === name)) throw new UserError("repos.errors.nameTaken", { name });

  const check = await checkRepo({ ...location, provider, token });
  const [row] = await db
    .insert(projectRepos)
    .values({
      projectId: input.projectId,
      name,
      provider,
      ...location,
      ...check,
      token: encrypt(token),
      tokenHint: tokenHint(token),
    })
    .returning()
    .catch((error: unknown) => {
      // Added meanwhile by a concurrent request.
      if (isUniqueViolation(error)) throw new UserError("repos.errors.alreadyAdded");
      throw error;
    });
  await audit({
    actor: opts.actor ?? "user",
    action: "repo.added",
    entityType: "project",
    entityId: input.projectId,
    data: { repo: `${location.host}/${location.path}`, name },
  });
  return omitToken(row!);
}

/**
 * Checks the repo again with the provider: its default branch and protection, and, with `token`,
 * replaces the stored token once the new one works.
 */
export async function recheckProjectRepo(
  input: { id: string; projectId: string; token?: string | null },
  opts: { actor?: string } = {},
): Promise<ProjectRepo> {
  const row = await repoRow(input.id, input.projectId);
  const newToken = input.token?.trim() || null;
  const access: RepoAccess = { ...row, token: newToken ?? decrypt(row.token) };
  const check = await checkRepo(access);
  const [updated] = await db
    .update(projectRepos)
    .set({
      ...check,
      checkedAt: new Date(),
      ...(newToken && { token: encrypt(newToken), tokenHint: tokenHint(newToken) }),
    })
    .where(eq(projectRepos.id, row.id))
    .returning();
  if (newToken) {
    await audit({
      actor: opts.actor ?? "user",
      action: "repo.token-replaced",
      entityType: "project",
      entityId: row.projectId,
      data: { repo: `${row.host}/${row.path}` },
    });
  }
  return omitToken(updated!);
}

/** Removes a repo. Its clone stays in the workspace, without credentials, until the workspace is reset. */
export async function deleteProjectRepo(input: { id: string; projectId: string }, opts: { actor?: string } = {}) {
  const row = await repoRow(input.id, input.projectId);
  await db.delete(projectRepos).where(eq(projectRepos.id, row.id));
  await audit({
    actor: opts.actor ?? "user",
    action: "repo.removed",
    entityType: "project",
    entityId: row.projectId,
    data: { repo: `${row.host}/${row.path}`, name: row.name },
  });
}

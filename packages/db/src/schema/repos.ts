import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { repoProvider } from "./enums";
import { projects } from "./projects";

/**
 * A git repository the agents of a project work on. It is cloned into `repos/<name>` of the
 * project's workspace, and git in the sandbox authenticates to it with `token`.
 */
export const projectRepos = pgTable(
  "project_repos",
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Folder under `repos/` in the workspace: lowercase letters, digits, dots, hyphens and underscores. */
    name: text().notNull(),
    provider: repoProvider().notNull(),
    /** Lowercase host, with the port when it is not 443: `github.com`, `gitlab.example.com:8443`. */
    host: text().notNull(),
    /** Path on the host without `.git`: `owner/repo`, or `group/subgroup/repo` on GitLab. */
    path: text().notNull(),
    defaultBranch: text().notNull(),
    /** Access token, encrypted with the vault key. Never sent to the browser. */
    token: text().notNull(),
    /** Last characters of the token, so the user can tell which one is set. */
    tokenHint: text().notNull(),
    /** Whether the provider protects the default branch, as of `checkedAt`; null when it could not be read. */
    defaultBranchProtected: boolean(),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The first also serves lookups by project.
  (t) => [unique().on(t.projectId, t.name), unique().on(t.projectId, t.host, t.path)],
);

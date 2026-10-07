import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./_shared";
import { agents } from "./agents";
import { conversations } from "./conversations";
import { previewKind } from "./enums";
import { projects } from "./projects";
import { runs } from "./runs";

/**
 * A link to something an agent made, served on its own subdomain by the worker: a copy of files
 * from the workspace (static: mockups, documents), or a port of the workspace's container (live: an
 * app the agent started). Private ones need the user's session; public ones only the link. It
 * belongs to the project or conversation whose workspace it shows and goes with it.
 */
export const previews = pgTable(
  "previews",
  {
    id: id(),
    /** The subdomain: 128 random bits in base32, the only thing a visitor needs besides access. */
    host: text().notNull().unique(),
    kind: previewKind().notNull(),
    title: text().notNull(),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "cascade" }),
    /** Workspace whose container a live preview reaches. */
    workspaceKey: text().notNull(),
    /** Live: the port inside the container. */
    port: integer(),
    /** Static: the file served at the root, relative to the copy (index.html, report.pdf). */
    entry: text(),
    public: boolean().notNull().default(false),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    runId: uuid().references(() => runs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.projectId),
    index().on(t.conversationId),
    index().on(t.expiresAt),
    index().on(t.runId),
    index().on(t.agentId),
    check("previews_one_owner", sql`num_nonnulls(${t.projectId}, ${t.conversationId}) = 1`),
    check(
      "previews_kind_fields",
      sql`(${t.kind} = 'live' and ${t.port} is not null) or (${t.kind} = 'static' and ${t.entry} is not null)`,
    ),
  ],
);

import { isUuid } from "@/lib/uuid";

/** The chat list's project filter, kept in `?project=`. Shared by server pages and client components. */

/** Filter value showing every conversation. */
export const ALL = "all";

/** Filter value (and project choice) for conversations outside any project. */
export const NO_PROJECT = "none";

/** Conversations the chat list shows at first, and adds with each "Show more". */
export const CHAT_LIST_PAGE_SIZE = 50;

/** `?project=` for a filter, so links and redirects keep it; empty for "all". */
export const filterQuery = (filter: string) => (filter === ALL ? "" : `?project=${filter}`);

/** The filter queries take: a project id, `{ projectId: null }` for conversations outside projects, or null for all. */
export type ConversationFilter = { projectId: string } | { projectId: null } | null;

/** `?project=` as a filter; anything else shows every conversation. */
export function parseConversationFilter(value: string | string[] | undefined): ConversationFilter {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === NO_PROJECT) return { projectId: null };
  return v && isUuid(v) ? { projectId: v } : null;
}

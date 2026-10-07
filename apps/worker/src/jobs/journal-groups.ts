/** Pure helpers for agent journals. No server imports, so they are testable on their own. */

/** A journal belongs to an agent and a project (null: work outside any project), one per day. */
export type JournalKey = { agentId: string; projectId: string | null };

/**
 * Groups items (a day's runs, unconsolidated journals) by the journal they belong to, in order of first
 * appearance; each group keeps its items in the order given.
 */
export function groupByJournal<T extends JournalKey>(items: T[]): (JournalKey & { items: T[] })[] {
  const groups = new Map<string, JournalKey & { items: T[] }>();
  for (const item of items) {
    const key = `${item.agentId}:${item.projectId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { agentId: item.agentId, projectId: item.projectId, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/** Heading of a journal in the digest prompt: the agent, the project it is about (if any) and the day. */
export function journalHeading(journal: { agent: string; project: string | null; day: string }): string {
  return journal.project
    ? `## ${journal.agent}, project ${journal.project} (${journal.day})`
    : `## ${journal.agent} (${journal.day})`;
}

/**
 * Splits what the digest covers by project: the model writing it reads only `open` items; `closed`
 * projects (whose provider restriction its model chain does not satisfy) keep theirs from it.
 */
export function splitByProject<T extends { projectId: string | null }>(
  items: T[],
  closed: ReadonlySet<string>,
): { open: T[]; closed: T[] } {
  const isClosed = (item: T) => item.projectId !== null && closed.has(item.projectId);
  return { open: items.filter((i) => !isClosed(i)), closed: items.filter(isClosed) };
}

/**
 * The closed projects' journals, appended to the digest as written: each is already a summary, written
 * by a model the project allows. Null when there are none.
 */
export function verbatimJournals(
  heading: string,
  journals: { agent: string; project: string | null; day: string; summary: string }[],
): string | null {
  if (!journals.length) return null;
  const entries = journals.map((j) => `**${j.project ? `${j.project} · ` : ""}${j.agent} (${j.day})**\n${j.summary}`);
  return [`**${heading}**`, ...entries].join("\n\n");
}

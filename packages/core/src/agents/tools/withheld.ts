/**
 * What a run's tools return of a project closed to its models (see projectsClosedTo): the metadata
 * (ids, titles, statuses, who) stays, the stored content is replaced by a note. Pure, so it is
 * testable on its own; shared.ts loads the closed projects for a run.
 */

export const WITHHELD_NOTE =
  "Withheld: this project's allowed AI providers do not include every model of this run, so its content is not shown here.";

type Withheld<T, K extends keyof T> = { [P in keyof T]: P extends K ? T[P] | typeof WITHHELD_NOTE : T[P] };

/** `item` with `fields` replaced by WITHHELD_NOTE when `closed` is true. */
export function withhold<T extends object, K extends keyof T>(
  item: T,
  closed: boolean,
  fields: readonly K[],
): Withheld<T, K> {
  // Every field of T still fits Withheld<T, K>, which only widens the withheld ones.
  if (!closed) return item as Withheld<T, K>;
  return { ...item, ...Object.fromEntries(fields.map((field) => [field, WITHHELD_NOTE])) } as Withheld<T, K>;
}

/** `item` with `fields` replaced by WITHHELD_NOTE when `projectId` is one of the closed projects. */
export function withholdClosed<T extends object, K extends keyof T>(
  item: T,
  projectId: string | null,
  closed: ReadonlySet<string>,
  fields: readonly K[],
): Withheld<T, K> {
  return withhold(item, projectId !== null && closed.has(projectId), fields);
}

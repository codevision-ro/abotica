/**
 * For tests only: a stand-in for the database client that answers each query from a queue per table and
 * records every write, so the delivery and messaging code is tested without Postgres. A select from a
 * table answers `answers[table]` in the order the queries come (empty when nothing is queued); an insert
 * answers `answers["insert:<table>"]`, by default its values with an id; an update answers
 * `answers["update:<table>"]`, by default nothing. Use it as the `db` of a mocked "@abotica/db", with the
 * tables `tables()` makes and "@abotica/db/orm" mocked to no-ops.
 */

type Write = { op: "insert" | "update" | "delete"; table: string; values?: Record<string, unknown> };

export function fakeDb() {
  const answers: Record<string, unknown[][]> = {};
  const writes: Write[] = [];
  const query = (op: "select" | Write["op"], start?: { name: string }) => {
    let table = start?.name ?? "";
    let values: Record<string, unknown> | undefined;
    const q: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
        if (op !== "select") writes.push({ op, table, values });
        const key = op === "select" ? table : `${op}:${table}`;
        const fallback = op === "insert" ? [{ id: `${table}-new`, ...values }] : [];
        return Promise.resolve(answers[key]?.shift() ?? fallback).then(ok, fail);
      },
    };
    for (const m of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "returning", "onConflictDoNothing", "for"]) {
      q[m] = () => q;
    }
    q.from = (t: { name: string }) => ((table = t.name), q);
    q.values = (v: Record<string, unknown>) => ((values = v), q);
    q.set = (v: Record<string, unknown>) => ((values = v), q);
    return q;
  };
  const db = {
    select: () => query("select"),
    selectDistinctOn: () => query("select"),
    insert: (t: { name: string }) => query("insert", t),
    update: (t: { name: string }) => query("update", t),
    delete: (t: { name: string }) => query("delete", t),
    execute: async () => [],
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  const reset = () => {
    for (const key of Object.keys(answers)) delete answers[key];
    writes.length = 0;
  };
  return { db, answers, writes, reset };
}

/** Tables as the fake reads them: by name only. */
export const tables = (...names: string[]) => Object.fromEntries(names.map((name) => [name, { name }]));

/** The orm helpers as no-ops, for a mocked "@abotica/db/orm". */
export const ormStubs = () =>
  Object.fromEntries(
    [
      "and",
      "asc",
      "count",
      "desc",
      "eq",
      "gt",
      "inArray",
      "isNotNull",
      "isNull",
      "lt",
      "lte",
      "ne",
      "notExists",
      "notInArray",
      "or",
      "sql",
    ].map((name) => [name, () => undefined]),
  );

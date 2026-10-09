/**
 * For tests only: the real database client, whose queries are built as usual but never sent. Each one
 * (select, update, insert, delete) goes to `answer` with its SQL and parameters, and resolves to the rows
 * `answer` returns, so a test sees what a module asks the database and decides what it gets back. Call
 * it in vi.mock("@abotica/db") on the actual module's client; nothing connects.
 */
import type { db as Db, tasks as Tasks } from "@abotica/db";
import { eq } from "@abotica/db/orm";

export type SentQuery = { sql: string; params: unknown[] };

type Thenable = { then: (...args: unknown[]) => unknown; toSQL: () => SentQuery };

/** The prototype that defines `then` for this kind of query (the select builder has its own copy). */
function thenOwner(query: object): Thenable {
  let proto = Object.getPrototypeOf(query) as object | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "then"))
    proto = Object.getPrototypeOf(proto) as object | null;
  if (!proto) throw new Error("not a query");
  return proto as Thenable;
}

/** `tasks`: the actual tasks table, only to find the builders' prototypes; nothing is sent. */
export function interceptQueries(
  db: typeof Db,
  tasks: typeof Tasks,
  answer: (query: SentQuery) => unknown[] | Promise<unknown[]>,
): void {
  const samples: object[] = [
    db.select().from(tasks),
    db.update(tasks).set({ title: "" }),
    db.insert(tasks).values({ title: "" }),
    db.delete(tasks).where(eq(tasks.id, "")),
  ];
  for (const proto of new Set(samples.map(thenOwner))) {
    proto.then = function (this: Thenable, resolve?: unknown, reject?: unknown) {
      const { sql, params } = this.toSQL();
      return Promise.resolve()
        .then(() => answer({ sql, params }))
        .then(resolve as (rows: unknown[]) => unknown, reject as (error: unknown) => unknown);
    };
  }
}

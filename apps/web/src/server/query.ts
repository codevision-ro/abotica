import "server-only";
import { requireUser } from "./session";

/**
 * The data access layer: every read in server/queries is wrapped in query(), so it checks the
 * session before touching data, whichever page, layout or segment calls it. The check is memoized
 * per request (see getSession), so wrapping many queries costs one session lookup.
 * Lint refuses an exported async function in server/queries that is not wrapped.
 */
export function query<A extends unknown[], R>(read: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    await requireUser();
    return read(...args);
  };
}

/** A read that is public on purpose (its caller authenticates another way, e.g. a webhook token). Say why at the call site. */
export function publicQuery<A extends unknown[], R>(read: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return read;
}

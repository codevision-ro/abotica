/** A unique constraint (or the named one) refused the write, possibly wrapped by the driver or by drizzle. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (
    let e = error as { code?: string; constraint_name?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === "23505" && (!constraint || e.constraint_name === constraint)) return true;
  }
  return false;
}

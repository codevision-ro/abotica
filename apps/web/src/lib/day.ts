const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` day, as journal filters take it. */
export const isDay = (value: string | undefined | null): value is string => !!value && DAY_RE.test(value);

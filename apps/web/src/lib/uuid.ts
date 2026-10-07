const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards uuid columns: Postgres throws on malformed input instead of matching nothing. */
export const isUuid = (value: string | null | undefined): value is string => !!value && UUID_RE.test(value);

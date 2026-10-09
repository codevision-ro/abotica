/** A search param's value as pages read it: the first one when the param is repeated. */
export const firstParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

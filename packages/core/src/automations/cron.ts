/** Cron syntax shared by the web form and the agents' schedule tool. Pure and client-safe. */

const PART = String.raw`(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?`;
const FIELD_RE = new RegExp(`^${PART}(,${PART})*$`);

/** Standard 5-field cron: numbers, ranges, lists and steps. */
export function isValidCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD_RE.test(f));
}

export const normalizeCron = (value: string) => value.trim().replace(/\s+/g, " ");

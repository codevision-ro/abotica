/**
 * Lowercase ASCII slug: accents stripped, runs of other characters collapsed to one hyphen,
 * cut to `maxLength` without a trailing hyphen. May be empty; callers pick their own fallback.
 * Pure, so client components can import it from `@abotica/core/slug`.
 */
export function slugify(value: string, maxLength = 64): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

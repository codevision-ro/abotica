/** Pure rules for comparing memory facts without embeddings. No server imports, so they are testable on their own. */

/** A fact's text as compared: case, spacing and trailing punctuation do not make it a different fact. */
export function factKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?…]+$/u, "")
    .trim();
}

/** Whether `fact` states one of the existing entries again, by text. */
export function restatesFact(fact: string, existing: readonly string[]): boolean {
  const key = factKey(fact);
  return existing.some((entry) => factKey(entry) === key);
}

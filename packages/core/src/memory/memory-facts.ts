/** Pure rules for comparing memory facts by their text. No server imports, so they are testable on their own. */

/** A fact's text as compared: case, spacing and trailing punctuation do not make it a different fact. */
export function factKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?…]+$/u, "")
    .trim();
}

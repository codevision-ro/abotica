/** Characters no POSIX shell treats specially; a leading "=" is excluded because zsh expands it. */
const SAFE_WORD = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@+=:,./-]*$/;

/** Quotes a value as one POSIX shell word. Plain words stay readable; anything else is single-quoted. */
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL bytes");
  if (SAFE_WORD.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

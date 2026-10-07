// Verifies every locale has exactly the keys of English, with the same {placeholders}.
import { locales, messages } from "../src/index";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = "", out = new Map<string, string>()) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, path, out);
  }
  return out;
}

/** Top-level ICU argument names: {name}, {count, plural, ...}. Nested plural branches are ignored. */
function args(message: string): string {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] === "{") {
      if (depth === 0) names.add(/^\{\s*(\w+)/.exec(message.slice(i))?.[1] ?? "");
      depth++;
    } else if (message[i] === "}") depth--;
  }
  return [...names].sort().join(",");
}

const base = flatten(messages.en as unknown as Tree);
let problems = 0;
function report(message: string) {
  problems++;
  console.error(message);
}

for (const locale of locales.filter((l) => l !== "en")) {
  const other = flatten(messages[locale] as unknown as Tree);
  for (const [key, value] of base) {
    if (!other.has(key)) report(`[${locale}] missing: ${key}`);
    else if (args(value) !== args(other.get(key)!)) report(`[${locale}] placeholders differ: ${key}`);
  }
  for (const key of other.keys()) if (!base.has(key)) report(`[${locale}] not in en: ${key}`);
}
console.log(problems ? `${problems} problem(s)` : `OK: ${base.size} keys in ${locales.length} locales`);
process.exit(problems ? 1 : 0);

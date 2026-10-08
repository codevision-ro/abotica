/**
 * Content checks for memory writes. Memory reaches the prompt of every later run of its scope, so a
 * write must not carry a secret, an instruction aimed at the agents or characters that hide text.
 *
 * Pure and client-safe. The patterns are a starting set to extend and test, not a complete detector:
 * - secrets are recognized by the shapes of well-known tokens and by the exact values the caller
 *   knows (vault secrets, repository tokens); a key of an unlisted provider, or a secret that is
 *   encoded, split or reworded, goes through;
 * - instruction patterns match common English phrasings (after folding fullwidth and compatibility
 *   forms); other languages, paraphrases and cross-script look-alikes (a Cyrillic "а") go through.
 *   They aim at phrases that rarely occur in a genuine fact, so a few legitimate notes (a curl how-to
 *   with a `$TOKEN`) are held for review rather than refused.
 */

export type MemoryFindingKind = "secret" | "injection" | "exfiltration" | "instruction-file" | "invisible";

/** `reason` says what matched, in English, for logs and for the agent; never the matched text itself. */
export type MemoryFinding = { kind: MemoryFindingKind; reason: string };

/** Kinds that hold a write for the user's review, most serious first (see memory-write-gate.ts). */
export const FLAG_KINDS = ["exfiltration", "instruction-file", "injection"] as const satisfies MemoryFindingKind[];
export type MemoryFlagKind = (typeof FLAG_KINDS)[number];

/** Values shorter than this would match inside ordinary text; the same floor as redact.ts. */
const MIN_KNOWN_SECRET_LENGTH = 8;

type Pattern = { pattern: RegExp; reason: string };

const SECRET_PATTERNS: Pattern[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, reason: "a private key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/, reason: "a GitHub token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/, reason: "a GitHub token" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, reason: "a GitLab token" },
  // OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), DeepSeek and others; a digit tells a key from a slug.
  { pattern: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/, reason: "an API key" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, reason: "a Slack token" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, reason: "an AWS access key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/, reason: "a Google API key" },
  { pattern: /\b[rs]k_live_[0-9A-Za-z]{20,}/, reason: "a Stripe key" },
  { pattern: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, reason: "a Telegram bot token" },
];

/**
 * A credential written out in an assignment: `api_key = "..."`, `password: '...'`. A value that is an
 * environment variable's name (`"MY_APP_TOKEN"`) says where the credential lives and is left alone.
 */
const HARDCODED =
  /\b(?:api[_-]?key|access[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']/gi;
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Up to 8 words between the key words of a phrase; bounded, so a long text cannot make it backtrack. */
const FILLER = String.raw`(?:[\w'-]+\s+){0,8}`;
const phrase = (source: string) => new RegExp(source, "i");

const INJECTION_PATTERNS: Pattern[] = [
  {
    pattern: phrase(
      String.raw`\bignore\s+${FILLER}(?:previous|all|above|prior|earlier|preceding|your)\s+${FILLER}(?:instructions|prompts?|rules|directions|guidelines)`,
    ),
    reason: "an instruction to ignore previous instructions",
  },
  {
    pattern: phrase(
      String.raw`\bdisregard\s+${FILLER}(?:previous|prior|above|your|all|any|the)\s+${FILLER}(?:instructions|prompts?|rules|guidelines)`,
    ),
    reason: "an instruction to disregard instructions",
  },
  {
    pattern: phrase(String.raw`\bforget\s+(?:everything|all|your)\s+${FILLER}(?:instructions|rules|guidelines|told)`),
    reason: "an instruction to forget instructions",
  },
  { pattern: /\byou\s+are\s+now\s+(?:a|an|the)\s+/i, reason: "a role change" },
  {
    pattern: phrase(String.raw`\bpretend\s+${FILLER}(?:you\s+are|to\s+be)\s+`),
    reason: "a role change",
  },
  { pattern: /\bnew\s+(?:system\s+)?instructions?\s*:/i, reason: "new instructions" },
  {
    pattern: /\bsystem\s+prompt\s+override\b|\boverride\s+(?:the\s+|your\s+)?system\s+prompt\b/i,
    reason: "a system prompt override",
  },
  {
    pattern: phrase(String.raw`\b(?:reveal|print|output|show|repeat|leak)\s+${FILLER}(?:system|initial|hidden)\s+prompt`),
    reason: "a request for the system prompt",
  },
  {
    pattern: phrase(String.raw`\b(?:do\s+not|don['\u2019]t)\s+${FILLER}(?:tell|inform)\s+${FILLER}the\s+user\b`),
    reason: "an instruction to hide something from the user",
  },
  {
    pattern: phrase(
      String.raw`\bact\s+as\s+(?:if|though)\s+${FILLER}you\s+${FILLER}(?:have\s+no|don['\u2019]t\s+have)\s+${FILLER}(?:restrictions|limits|rules)`,
    ),
    reason: "an instruction to drop restrictions",
  },
  // Fake role and system tags. Lowercase only: `<User>` is a common component name.
  { pattern: /<\s*\/?\s*(?:system|assistant|developer|user|instructions?)\s*>/, reason: "a fake role tag" },
  {
    pattern: /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/,
    reason: "a fake role tag",
  },
  { pattern: /\[\s*(?:system\s*message|system|assistant|developer|internal)\s*\]/i, reason: "a fake role tag" },
  // The wrapper of untrusted data (agents/untrusted.ts): memory has no business carrying it.
  { pattern: /<\s*\/?\s*untrusted[\s_-]*data\b/i, reason: "an untrusted-data tag" },
];

/** An environment variable whose name ends like a credential (`$GITHUB_TOKEN`, `${API_KEY}`). */
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)S?\b`;

const EXFILTRATION_PATTERNS: Pattern[] = [
  {
    pattern: phrase(
      String.raw`\b(?:curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]{0,300}${SECRET_VAR}`,
    ),
    reason: "a command that sends a credential variable",
  },
  { pattern: phrase(String.raw`https?://[^\s"'<>]*${SECRET_VAR}`), reason: "a URL that carries a credential variable" },
  {
    pattern:
      /\b(?:cat|less|more|head|tail|type|base64|xxd|strings)\b[^\n]{0,200}(?:\.env(?![\w.-])|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|\.aws\/credentials|\.docker\/config\.json)/i,
    reason: "a command that reads credential files",
  },
  {
    pattern:
      /\b(?:send|post|upload|transmit|forward|exfiltrate|leak|share)\b[^\n]{0,200}\b(?:api[\s_-]?keys?|tokens?|secrets?|passwords?|credentials?|env(?:ironment)?\s+variables?)\b[^\n]{0,200}\b(?:to|at)\s+https?:\/\//i,
    reason: "an instruction to send credentials to a URL",
  },
];

const INSTRUCTION_FILE_PATTERNS: Pattern[] = [
  {
    pattern:
      /\b(?:update|modify|edit|write|change|append|add\s+to|overwrite|replace|rewrite|delete|remove|prepend|insert)\b[^\n]{0,200}(?:\b(?:AGENTS|CLAUDE|SKILL|GEMINI|SOUL)\.md\b|\.cursorrules|\.clinerules|\.windsurfrules|copilot-instructions\.md)/i,
    reason: "an instruction to change an agent instruction file",
  },
  {
    pattern:
      /\b(?:update|change|modify|rewrite|replace|edit)\s+(?:your|the\s+agents?'?s?)\s+(?:own\s+)?(?:instructions|system\s+prompt|persona|permissions)\b/i,
    reason: "an instruction to change the agent's instructions",
  },
];

/**
 * Characters that are not seen when the text is read: zero-width characters, the bidi embedding,
 * override and isolate controls (which can make text read differently from how it is stored) and
 * the Unicode tag block (which can spell out a hidden ASCII message). A zero-width joiner inside an
 * emoji sequence is kept; the joiner of other scripts (Persian) and subdivision flags are not.
 */
const INVISIBLE =
  /[​‌⁠⁢-⁤﻿‪-‮⁦-⁩\u{e0000}-\u{e007f}]|(?<![\p{Extended_Pictographic}\u{1f3fb}-\u{1f3ff}️])‍|‍(?!\p{Extended_Pictographic})/gu;

/** `text` without the characters INVISIBLE matches; what memory stores. */
export const stripInvisible = (text: string): string => text.replace(INVISIBLE, "");

/** Soft hyphens are kept in what is stored (they mark break points) but would split a pattern's words. */
const forPatterns = (text: string) => stripInvisible(text).normalize("NFKC").replace(/­/g, "");

const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** Every finding, at most one per reason. `knownSecrets` are values that must never be stored. */
export function scanMemoryContent(text: string, opts: { knownSecrets?: readonly string[] } = {}): MemoryFinding[] {
  const findings: MemoryFinding[] = [];
  const add = (kind: MemoryFindingKind, reason: string) => {
    if (!findings.some((f) => f.kind === kind && f.reason === reason)) findings.push({ kind, reason });
  };

  const hidden = [...new Set(text.match(INVISIBLE) ?? [])];
  if (hidden.length) add("invisible", `invisible characters (${hidden.map(codePoint).join(", ")})`);

  // Matched on the text as stored, so a secret split by a zero-width character is still found.
  const visible = stripInvisible(text);
  for (const secret of opts.knownSecrets ?? []) {
    if (secret.length >= MIN_KNOWN_SECRET_LENGTH && visible.includes(secret)) add("secret", "a known secret value");
  }
  const folded = forPatterns(text);
  for (const { pattern, reason } of SECRET_PATTERNS) if (pattern.test(folded)) add("secret", reason);
  for (const [, value] of folded.matchAll(HARDCODED)) {
    if (!ENV_NAME.test(value!)) add("secret", "a hard-coded credential");
  }

  const groups: [MemoryFindingKind, Pattern[]][] = [
    ["injection", INJECTION_PATTERNS],
    ["exfiltration", EXFILTRATION_PATTERNS],
    ["instruction-file", INSTRUCTION_FILE_PATTERNS],
  ];
  for (const [kind, patterns] of groups) {
    for (const { pattern, reason } of patterns) if (pattern.test(folded)) add(kind, reason);
  }
  return findings;
}

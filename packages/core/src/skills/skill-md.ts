// The Agent Skills folder format: SKILL.md (YAML frontmatter + markdown body) plus supporting files.
// Pure, so client components can import it from `@abotica/core/skill-md`.
import { parse, stringify } from "yaml";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES, SKILL_MAX_TOTAL_BYTES } from "../platform/limits";

export const SKILL_MD = "SKILL.md";

export type SkillFileEntry = { path: string; content: string };

/** A skill folder ready to store: frontmatter split into fields, SKILL.md holding only the body. */
export type SkillPackage = {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  files: SkillFileEntry[];
};

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function normalizeText(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Splits a SKILL.md into its frontmatter fields and body. Invalid YAML leaves every field empty. */
export function parseSkillMd(raw: string): {
  name?: string;
  description?: string;
  metadata: Record<string, unknown>;
  body: string;
} {
  const text = normalizeText(raw);
  const match = FRONTMATTER.exec(text);
  if (!match) return { metadata: {}, body: text.trim() };
  let data: unknown;
  try {
    data = parse(match[1]!);
  } catch {
    data = null;
  }
  const body = text.slice(match[0].length).trim();
  if (!data || typeof data !== "object" || Array.isArray(data)) return { metadata: {}, body };
  const { name, description, ...metadata } = data as Record<string, unknown>;
  return {
    name: typeof name === "string" ? name.trim() : undefined,
    description: typeof description === "string" ? description.replace(/\s+/g, " ").trim() : undefined,
    metadata,
    body,
  };
}

export function serializeSkillMd(skill: {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  body: string;
}): string {
  const frontmatter = stringify(
    { name: skill.name, description: skill.description, ...skill.metadata },
    { lineWidth: 0 },
  ).trimEnd();
  return `---\n${frontmatter}\n---\n\n${skill.body.trim()}\n`;
}

/** "./a//b.md" -> "a/b.md"; null for paths that leave the folder or are not plain relative paths. */
export function normalizeSkillPath(path: string): string | null {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.length > 120)) return null;
  if (parts.some((p) => /[\u0000-\u001f]/.test(p))) return null;
  const normalized = parts.join("/");
  return normalized.length <= 255 ? normalized : null;
}

/** False for content that is not plain text (a NUL byte means a binary file decoded as text). */
export function isTextContent(content: string): boolean {
  return !content.includes("\u0000");
}

/** SKILL.md first, then folders before files at each level, alphabetically. */
export function compareSkillPaths(a: string, b: string): number {
  if (a === SKILL_MD) return -1;
  if (b === SKILL_MD) return 1;
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aIsDir = i < pa.length - 1;
    const bIsDir = i < pb.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return pa[i]!.localeCompare(pb[i]!);
  }
  return pa.length - pb.length;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

export type SkillFilesProblem =
  | { code: "missingSkillMd" }
  | { code: "invalidPath"; path: string }
  | { code: "duplicatePath"; path: string }
  | { code: "binaryFile"; path: string }
  | { code: "tooManyFiles"; max: number }
  | { code: "fileTooLarge"; path: string; maxBytes: number }
  | { code: "tooLarge"; maxBytes: number };

/** Checks a stored skill folder (paths already normalized, SKILL.md holding the body). */
export function checkSkillFiles(files: SkillFileEntry[]): SkillFilesProblem | null {
  if (!files.some((f) => f.path === SKILL_MD)) return { code: "missingSkillMd" };
  if (files.length > SKILL_MAX_FILES) return { code: "tooManyFiles", max: SKILL_MAX_FILES };
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (normalizeSkillPath(file.path) !== file.path) return { code: "invalidPath", path: file.path };
    if (seen.has(file.path)) return { code: "duplicatePath", path: file.path };
    seen.add(file.path);
    if (!isTextContent(file.content)) return { code: "binaryFile", path: file.path };
    const bytes = utf8Length(file.content);
    if (bytes > SKILL_MAX_FILE_BYTES) return { code: "fileTooLarge", path: file.path, maxBytes: SKILL_MAX_FILE_BYTES };
    total += bytes;
  }
  if (total > SKILL_MAX_TOTAL_BYTES) return { code: "tooLarge", maxBytes: SKILL_MAX_TOTAL_BYTES };
  return null;
}

/**
 * Turns the raw files of a skill folder (from a zip, a folder upload, GitHub or skills.sh) into a
 * package. A single top-level folder around SKILL.md is unwrapped; files outside the skill folder,
 * binary files and invalid paths are dropped and reported in `skipped`.
 * Null when there is no SKILL.md.
 */
export function packageSkillFiles(raw: SkillFileEntry[]): { pkg: SkillPackage; skipped: string[] } | null {
  const entries = raw.flatMap((f) => {
    const path = normalizeSkillPath(f.path);
    return path ? [{ path, content: normalizeText(f.content) }] : [];
  });
  // The shallowest SKILL.md marks the skill folder.
  const skillMd = entries
    .filter((f) => f.path === SKILL_MD || f.path.endsWith(`/${SKILL_MD}`))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  if (!skillMd) return null;
  const root = skillMd.path.slice(0, -SKILL_MD.length);
  const skipped: string[] = [];
  const files: SkillFileEntry[] = [];
  const seen = new Set<string>();
  for (const f of entries) {
    if (!f.path.startsWith(root) || f.path === skillMd.path) {
      if (f.path !== skillMd.path) skipped.push(f.path);
      continue;
    }
    const path = f.path.slice(root.length);
    if (seen.has(path) || !isTextContent(f.content)) {
      skipped.push(f.path);
      continue;
    }
    seen.add(path);
    files.push({ path, content: f.content });
  }
  const md = parseSkillMd(skillMd.content);
  const folderName = root.split("/").filter(Boolean).at(-1) ?? "";
  return {
    pkg: {
      name: md.name || folderName,
      description: md.description ?? "",
      metadata: md.metadata,
      files: [{ path: SKILL_MD, content: md.body }, ...files].sort((a, b) => compareSkillPaths(a.path, b.path)),
    },
    skipped,
  };
}

/** The folder back as files, SKILL.md with its frontmatter, e.g. for a zip export. */
export function skillPackageFiles(pkg: SkillPackage): SkillFileEntry[] {
  return pkg.files.map((f) =>
    f.path === SKILL_MD ? { path: SKILL_MD, content: serializeSkillMd({ ...pkg, body: f.content }) } : f,
  );
}

/** Relative links and paths in markdown that point inside the skill folder ("references/api.md"). */
export function referencedSkillPaths(markdown: string, fromPath = SKILL_MD): string[] {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
  const found = new Set<string>();
  const add = (target: string) => {
    const clean = target.split(/[?#]/)[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) return;
    const path = normalizeSkillPath(dir + clean);
    if (path) found.add(path);
  };
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) add(m[1]!);
  for (const m of markdown.matchAll(/`((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\.\w+)`/g)) add(m[1]!);
  return [...found];
}

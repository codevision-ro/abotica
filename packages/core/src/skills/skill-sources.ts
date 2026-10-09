import type { SkillOrigin, SkillSource } from "@abotica/db";
import { UserError } from "@abotica/i18n";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES } from "../platform/limits";
import { packageSkillFiles, parseSkillMd, SKILL_MD, type SkillFileEntry, type SkillPackage } from "./skill-md";
import { slugify } from "../platform/slug";
import { getSecret } from "../platform/vault";

/**
 * Remote skill sources: skills.sh (search and folder snapshots, the endpoints its own `npx skills`
 * CLI uses) and GitHub repositories. Nothing here writes to the database.
 */

const SKILLS_SH = "https://skills.sh";
const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 15_000;
/** A repo with more SKILL.md files than this is listed by folder name only, without reading each one. */
const MAX_LISTED_SKILLS = 60;

export type SkillSourceRef =
  { kind: "skills.sh"; id: string } | { kind: "github"; repo: string; ref?: string; path?: string };

export type SkillsShResult = { id: string; source: string; skillId: string; name: string; installs: number };

/** A skill fetched from its source, not stored yet. */
export type FetchedSkill = {
  pkg: SkillPackage;
  /** Files left out: binary, too large or outside the skill folder. */
  skipped: string[];
  source: SkillOrigin;
};

/** One skill among several found at a URL, to pick from. */
export type SkillChoice = { ref: SkillSourceRef; name: string; description: string };

type ResolvedSkillUrl = { kind: "single"; skill: FetchedSkill } | { kind: "many"; choices: SkillChoice[] };

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new UserError("skills.errors.sourceUnreachable", { host: new URL(url).host });
  }
}

/** Hash of a folder's files, independent of order and of how they were downloaded. */
export function hashSkillFiles(files: SkillFileEntry[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${f.path}\0${f.content}\0`);
  return hash.digest("hex");
}

/** Hash of a stored skill, to tell whether it still matches what was installed. */
export function hashSkillPackage(pkg: SkillPackage): string {
  return hashSkillFiles([
    { path: "\0meta", content: JSON.stringify([pkg.name, pkg.description, pkg.metadata]) },
    ...pkg.files,
  ]);
}

/** Downloaded files as a skill; `skipped` are the files the download already left out. */
function fetchedSkill(files: SkillFileEntry[], skipped: string[], source: SkillOrigin): FetchedSkill {
  const packaged = packageSkillFiles(files);
  if (!packaged) throw new UserError("skills.errors.noSkillMd");
  return { pkg: packaged.pkg, skipped: [...skipped, ...packaged.skipped], source };
}

// ─── skills.sh ───

const skillsShSearch = z.object({
  skills: z
    .array(
      z.object({
        id: z.string().nullish(),
        source: z.string().nullish(),
        skillId: z.string().nullish(),
        name: z.string().nullish(),
        installs: z.number().nullish(),
      }),
    )
    .nullish(),
});

const skillsShDownload = z.object({
  files: z.array(z.object({ path: z.string(), contents: z.string() })).nullish(),
});

export async function searchSkillsSh(query: string, limit = 30): Promise<SkillsShResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await request(`${SKILLS_SH}/api/search?${new URLSearchParams({ q, limit: String(limit) })}`);
  if (!res.ok) throw new UserError("skills.errors.searchFailed");
  const body = skillsShSearch.safeParse(await res.json().catch(() => null));
  if (!body.success) throw new UserError("skills.errors.searchFailed");
  return (body.data.skills ?? []).flatMap((s) =>
    s.id && s.source && s.skillId
      ? [{ id: s.id, source: s.source, skillId: s.skillId, name: s.name || s.skillId, installs: s.installs ?? 0 }]
      : [],
  );
}

function splitSkillsShId(id: string): { repo: string; skillId: string } {
  const parts = id.split("/");
  if (parts.length !== 3 || parts.some((p) => !p)) throw new UserError("skills.errors.invalidSource");
  return { repo: `${parts[0]}/${parts[1]}`, skillId: parts[2]! };
}

async function fetchFromSkillsSh(id: string): Promise<FetchedSkill> {
  const { repo, skillId } = splitSkillsShId(id);
  const res = await request(`${SKILLS_SH}/api/download/${id.split("/").map(encodeURIComponent).join("/")}`);
  let files: SkillFileEntry[] | null = null;
  if (res.ok) {
    // A snapshot in another shape counts as none: the folder is read from GitHub instead.
    const body = skillsShDownload.safeParse(await res.json().catch(() => null));
    files = body.data?.files?.map((f) => ({ path: f.path, content: f.contents })) ?? null;
  }
  let skipped: string[] = [];
  // No snapshot on skills.sh: read the same folder from GitHub, as the skills CLI does.
  if (!files) {
    const folder = await findGitHubSkillFolder(repo, skillId);
    ({ files, skipped } = await readGitHubFolder(repo, folder.ref, folder.path, folder.entries));
  }
  return fetchedSkill(files, skipped, { kind: "skills.sh", id, url: `${SKILLS_SH}/${id}`, hash: hashSkillFiles(files) });
}

// ─── GitHub ───

// `type` is also "commit" (a submodule), which is neither a file nor a folder here.
const treeEntry = z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() });
type TreeEntry = z.infer<typeof treeEntry>;
type RepoTree = { ref: string; entries: TreeEntry[] };

async function githubHeaders(): Promise<HeadersInit> {
  // Optional, and only a global one: imported skills belong to no project.
  const token = await getSecret("GITHUB_TOKEN");
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await request(`${GITHUB_API}${path}`, { headers: await githubHeaders() });
  if (res.status === 404) throw new UserError("skills.errors.githubNotFound");
  if (res.status === 403 || res.status === 429) throw new UserError("skills.errors.githubRateLimited");
  if (!res.ok) throw new UserError("skills.errors.githubFailed", { status: res.status });
  const body = schema.safeParse(await res.json().catch(() => null));
  if (!body.success) throw new UserError("skills.errors.githubFailed", { status: res.status });
  return body.data;
}

async function fetchRepoTree(repo: string, ref?: string): Promise<RepoTree> {
  const branch = ref ?? (await githubJson(`/repos/${repo}`, z.object({ default_branch: z.string() }))).default_branch;
  const tree = await githubJson(
    `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    z.object({ tree: z.array(treeEntry) }),
  );
  return { ref: branch, entries: tree.tree };
}

const skillMdPaths = (entries: TreeEntry[], under: string) =>
  entries
    .filter(
      (e) =>
        e.type === "blob" &&
        (e.path === `${under}${SKILL_MD}` || (e.path.startsWith(under) && e.path.endsWith(`/${SKILL_MD}`))),
    )
    .map((e) => e.path)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

const folderOf = (skillMdPath: string) => skillMdPath.slice(0, -SKILL_MD.length).replace(/\/$/, "");

async function fetchRaw(repo: string, ref: string, path: string): Promise<string | null> {
  const res = await request(
    `${GITHUB_RAW}/${repo}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`,
  );
  if (!res.ok) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
  } catch {
    return null; // not text
  }
}

/** The folder of skill `skillId` in a repo: a folder with that name, else the SKILL.md whose name matches. */
async function findGitHubSkillFolder(repo: string, skillId: string) {
  const tree = await fetchRepoTree(repo);
  const paths = skillMdPaths(tree.entries, "");
  const byFolder = paths.find((p) => folderOf(p).split("/").at(-1) === skillId);
  if (byFolder) return { ref: tree.ref, path: folderOf(byFolder), entries: tree.entries };
  for (const p of paths.slice(0, MAX_LISTED_SKILLS)) {
    const md = await fetchRaw(repo, tree.ref, p);
    if (md && slugify(parseSkillMd(md).name ?? "") === skillId)
      return { ref: tree.ref, path: folderOf(p), entries: tree.entries };
  }
  throw new UserError("skills.errors.githubNotFound");
}

async function readGitHubFolder(repo: string, ref: string, folder: string, entries: TreeEntry[]) {
  const prefix = folder ? `${folder}/` : "";
  const blobs = entries.filter((e) => e.type === "blob" && e.path.startsWith(prefix));
  const skipped: string[] = [];
  const wanted = blobs.filter((b) => {
    const ok = (b.size ?? 0) <= SKILL_MAX_FILE_BYTES;
    if (!ok) skipped.push(b.path.slice(prefix.length));
    return ok;
  });
  if (wanted.length > SKILL_MAX_FILES) throw new UserError("skills.errors.tooManyFiles", { max: SKILL_MAX_FILES });
  const files: SkillFileEntry[] = [];
  // A few at a time: raw.githubusercontent.com throttles bursts.
  for (let i = 0; i < wanted.length; i += 8) {
    const batch = await Promise.all(
      wanted
        .slice(i, i + 8)
        .map(async (b) => ({ path: b.path.slice(prefix.length), content: await fetchRaw(repo, ref, b.path) })),
    );
    for (const f of batch) {
      if (f.content === null) skipped.push(f.path);
      else files.push({ path: f.path, content: f.content });
    }
  }
  return { files, skipped };
}

async function fetchFromGitHub(repo: string, ref: string | undefined, path: string): Promise<FetchedSkill> {
  const tree = await fetchRepoTree(repo, ref);
  const folder = path.replace(/\/?SKILL\.md$/, "").replace(/^\/+|\/+$/g, "");
  if (folder && !tree.entries.some((e) => e.type === "tree" && e.path === folder))
    throw new UserError("skills.errors.githubNotFound");
  const { files, skipped } = await readGitHubFolder(repo, tree.ref, folder, tree.entries);
  return fetchedSkill(files, skipped, {
    kind: "github",
    repo,
    ref: tree.ref,
    path: folder,
    url: `https://github.com/${repo}/tree/${tree.ref}${folder ? `/${folder}` : ""}`,
    hash: hashSkillFiles(files),
  });
}

/** Skills inside a GitHub folder (or the whole repo): one fetched skill, or a list to choose from. */
async function resolveGitHub(repo: string, ref: string | undefined, path: string): Promise<ResolvedSkillUrl> {
  const tree = await fetchRepoTree(repo, ref);
  const under = path ? `${path.replace(/\/?SKILL\.md$/, "").replace(/\/+$/, "")}/` : "";
  const paths = skillMdPaths(tree.entries, under === "/" ? "" : under);
  if (!paths.length) throw new UserError("skills.errors.noSkillMd");
  if (paths[0] === `${under}${SKILL_MD}` || paths.length === 1) {
    return { kind: "single", skill: await fetchFromGitHub(repo, tree.ref, folderOf(paths[0]!)) };
  }
  const listed = paths.slice(0, MAX_LISTED_SKILLS);
  const choices = await Promise.all(
    listed.map(async (p): Promise<SkillChoice> => {
      const md = paths.length <= MAX_LISTED_SKILLS ? await fetchRaw(repo, tree.ref, p) : null;
      const parsed = md ? parseSkillMd(md) : null;
      const folder = folderOf(p);
      return {
        ref: { kind: "github", repo, ref: tree.ref, path: folder },
        name: parsed?.name || folder.split("/").at(-1) || repo,
        description: parsed?.description ?? "",
      };
    }),
  );
  return { kind: "many", choices };
}

// ─── Entry points ───

export async function fetchSkill(ref: SkillSourceRef): Promise<FetchedSkill> {
  return ref.kind === "skills.sh" ? fetchFromSkillsSh(ref.id) : fetchFromGitHub(ref.repo, ref.ref, ref.path ?? "");
}

/** Where a stored skill came from, to fetch it again. */
export const sourceRef = (source: SkillSource): SkillSourceRef =>
  source.kind === "skills.sh"
    ? { kind: "skills.sh", id: source.id }
    : { kind: "github", repo: source.repo, ref: source.ref, path: source.path };

/** The upstream hash of a stored source, to compare with the one saved at install. */
export async function fetchSourceHash(source: SkillSource): Promise<string> {
  return (await fetchSkill(sourceRef(source))).source.hash;
}

/**
 * Accepts a skills.sh page ("https://skills.sh/owner/repo/skill"), a GitHub repo, folder or SKILL.md URL
 * ("https://github.com/owner/repo/tree/main/skills/pdf"), or the "owner/repo" shorthand.
 */
export function parseSkillUrl(input: string): SkillSourceRef | null {
  const value = input.trim().replace(/\.git$/, "");
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
  if (shorthand) return { kind: "github", repo: `${shorthand[1]}/${shorthand[2]}` };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.replace(/^www\./, "");
  if (host === "skills.sh" && parts.length === 3) return { kind: "skills.sh", id: parts.join("/") };
  if (host !== "github.com" || parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
    return { kind: "github", repo, ref: parts[3], path: parts.slice(4).join("/") };
  }
  return parts.length === 2 ? { kind: "github", repo } : null;
}

export async function resolveSkillUrl(input: string): Promise<ResolvedSkillUrl> {
  const ref = parseSkillUrl(input);
  if (!ref) throw new UserError("skills.errors.invalidUrl");
  if (ref.kind === "skills.sh") return { kind: "single", skill: await fetchFromSkillsSh(ref.id) };
  return resolveGitHub(ref.repo, ref.ref, ref.path ?? "");
}

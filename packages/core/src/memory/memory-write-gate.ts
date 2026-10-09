/**
 * What a memory write may store, and in which state (see memory-scan.ts for the checks):
 * - a secret refuses the write;
 * - content that looks like an instruction aimed at the agents (FLAG_KINDS) waits for the user's
 *   approval (pending), whatever `memoryRequiresApproval` says;
 * - content that came from untrusted data and passes the scan is stored as asked (pending only when
 *   `memoryRequiresApproval` is on), keeping origin "untrusted": prompts mark it as from external content
 *   (see markExternal);
 * - invisible characters are stripped.
 * The user's own writes are never held for the user's own review; a finding is still recorded.
 */
import { db, memories, projectAgents, projectRepos, projects } from "@abotica/db";
import { and, cosineDistance, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { OWNER_SECRETS, secretValues } from "../platform/vault";
import { restatesFact } from "./memory-facts";
import { FLAG_KINDS, type MemoryFinding, type MemoryFlagKind, scanMemoryContent, stripInvisible } from "./memory-scan";
import { nearestFirst } from "./memory-search";

type Memory = typeof memories.$inferSelect;

/** The write holds a secret; nothing was stored. */
export class MemorySecretError extends UserError {
  constructor(readonly reasons: string[]) {
    super("memory.errors.containsSecret");
  }
}

/** What the agent tools return for a refused write: where the value belongs instead. */
export const SECRET_REFUSED =
  "Not saved: the content contains what looks like a secret (an API key, a token, a password or a private key). Never store secrets in memory: the user keeps the value in the vault (Settings > Secrets); save only the secret's name.";

/**
 * The write as it is stored. `status` is undefined when the caller keeps the current one (an edit)
 * and nothing holds the write. `flagReason` is the most serious kind of instruction found.
 */
export type CheckedWrite = {
  content: string;
  status: Memory["status"] | undefined;
  flagReason: MemoryFlagKind | null;
  findings: MemoryFinding[];
};

type WriteCheck = { origin: Memory["origin"]; status?: Memory["status"]; knownSecrets?: readonly string[] };

/** Throws MemorySecretError when `content` holds a secret. */
export function decideMemoryWrite(content: string, { origin, status, knownSecrets }: WriteCheck): CheckedWrite {
  const findings = scanMemoryContent(content, { knownSecrets });
  const secrets = findings.filter((f) => f.kind === "secret");
  if (secrets.length) throw new MemorySecretError(secrets.map((f) => f.reason));
  const flagReason = FLAG_KINDS.find((kind) => findings.some((f) => f.kind === kind)) ?? null;
  const held = origin !== "owner" && flagReason !== null;
  return { content: stripInvisible(content), status: held ? "pending" : status, flagReason, findings };
}

/** `decideMemoryWrite` against every vault secret as well as the `knownSecrets` of the caller (a run's repository tokens). */
export async function checkMemoryWrite(content: string, check: WriteCheck): Promise<CheckedWrite> {
  const vault = await secretValues(OWNER_SECRETS);
  return decideMemoryWrite(content, { ...check, knownSecrets: [...(check.knownSecrets ?? []), ...vault] });
}

/** Why an agent's write waits for approval, for the tool's answer; null when it does not. */
export function heldBecause(checked: CheckedWrite): string | null {
  if (checked.status !== "pending") return null;
  if (checked.flagReason) {
    const reason = checked.findings.find((f) => f.kind === checked.flagReason)!.reason;
    return `It looks like ${reason}, so it waits for the user's approval before agents can read it.`;
  }
  return "Memory written by agents waits for the user's approval.";
}

/**
 * The entries of the memory a write goes to: global memory, one project's team memory, an agent's craft
 * (no project) or its notes on one project.
 */
export function sameMemory(target: { scope: Memory["scope"]; projectId?: string | null; agentId?: string | null }) {
  if (target.scope === "global") return eq(memories.scope, "global");
  if (target.scope === "project") {
    return and(eq(memories.scope, "project"), eq(memories.projectId, target.projectId ?? ""));
  }
  return and(
    eq(memories.scope, "agent"),
    eq(memories.agentId, target.agentId ?? ""),
    target.projectId ? eq(memories.projectId, target.projectId) : isNull(memories.projectId),
  );
}

/** Cosine distance under which two entries state the same fact. */
export const SAME_FACT_DISTANCE = 0.15;

/**
 * Up to which distance an entry is about the same thing as a new fact, which may then replace it.
 * Measured on Romanian facts with the built-in model (paraphrase-multilingual-mpnet-base-v2): a fact
 * that contradicts an entry sits near 0.38, different facts on the same topic near 0.7.
 */
export const RELATED_DISTANCE = 0.4;

const MAX_RELATED = 3;

export type SimilarMemory = { id: string; content: string; source: string };

/**
 * The entries `where` selects that a new fact restates (`duplicate`) or is close to (`related`,
 * nearest first). Without an embedding a fact restates an entry only by its text (see restatesFact)
 * and nothing is related.
 */
export async function similarMemories(
  where: SQL | undefined,
  content: string,
  embedding: number[] | null,
): Promise<{ duplicate: SimilarMemory | null; related: SimilarMemory[] }> {
  const fields = { id: memories.id, content: memories.content, source: memories.source };
  if (!embedding) {
    const rows = await db.select(fields).from(memories).where(where);
    return { duplicate: rows.find((row) => restatesFact(content, [row.content])) ?? null, related: [] };
  }
  const distance = cosineDistance(memories.embedding, embedding);
  const nearest = await nearestFirst((tx) =>
    tx
      .select({ row: fields, distance: sql<number>`${distance}` })
      .from(memories)
      .where(and(where, isNotNull(memories.embedding)))
      .orderBy(distance)
      .limit(MAX_RELATED),
  );
  const [closest] = nearest;
  if (closest && Number(closest.distance) < SAME_FACT_DISTANCE) return { duplicate: closest.row, related: [] };
  return { duplicate: null, related: nearest.filter((n) => Number(n.distance) < RELATED_DISTANCE).map((n) => n.row) };
}

/** What names a project in a memory entry: its name, its slug, and the domains of its texts and repositories. */
export type ProjectIdentity = { id: string; name: string; slug: string; texts: string[]; repoHosts: string[] };

/** Case and diacritics do not count: "Bețpavin" and "betpavin" are the same name. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Hosts every project's repositories live on: naming one names no project. */
const PUBLIC_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

/** Endings of file names and frameworks ("Next.js", "README.md"), which are not domains. */
const FILE_ENDINGS = new Set(
  "js ts jsx tsx mjs cjs py rb rs go md mdx json css scss html htm php vue sh yml yaml toml txt lock sql java kt swift cpp cs env log pdf png jpg svg".split(
    " ",
  ),
);

const DOMAIN = /(?<![\p{L}\p{N}.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![\p{L}\p{N}-])/gu;

/** The domains a text names, without "www.". */
function domainsIn(text: string): string[] {
  return [...fold(text).matchAll(DOMAIN)]
    .map(([domain]) => domain.replace(/^www\./, ""))
    .filter((domain) => !FILE_ENDINGS.has(domain.slice(domain.lastIndexOf(".") + 1)));
}

/** The name a domain stands for, often written without its ending: "avocatulonline" of "avocatulonline.ro". */
function domainName(domain: string): string | undefined {
  const labels = domain.split(".").slice(0, -1);
  // Past second-level endings such as "co" of "co.uk" or "com" of "com.ro".
  while (labels.length > 1 && labels.at(-1)!.length <= 3) labels.pop();
  return labels.at(-1);
}

/** Letters and digits of a term, what its length counts. */
const compact = (term: string) => term.replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The terms that name a project, folded: its name, its slug, and the domains (with their names) in its
 * description, goals and repository hosts. A term shorter than 4 characters names nothing ("app", "seo"),
 * except the project's full name.
 */
export function projectTerms(project: Omit<ProjectIdentity, "id">): string[] {
  const hosts = project.repoHosts.map((host) => fold(host).replace(/:\d+$/, "")).filter((h) => !PUBLIC_GIT_HOSTS.has(h));
  const domains = [...project.texts.flatMap(domainsIn), ...hosts];
  const terms = [project.slug, ...domains, ...domains.map(domainName)].map((t) => fold(t ?? "").trim());
  const name = fold(project.name).trim();
  return [...new Set([...(compact(name) ? [name] : []), ...terms.filter((t) => compact(t).length >= 4)])];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A term as a whole word or phrase. Words may be joined by spaces, hyphens, underscores or nothing:
 * "Avocatul Online" also matches "avocatul-online" and "AvocatulOnline".
 */
function termPattern(term: string): RegExp {
  const words = term
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(escape);
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]*")}(?![\\p{L}\\p{N}])`, "u");
}

/**
 * The first project of `projects` that `content` names, with the term as found in the content (folded);
 * null when it names none.
 */
export function projectNamed(
  content: string,
  projects: readonly ProjectIdentity[],
): { term: string; projectId: string } | null {
  const text = fold(content);
  for (const project of projects) {
    for (const term of projectTerms(project)) {
      const found = termPattern(term).exec(text);
      if (found) return { term: found[0], projectId: project.id };
    }
  }
  return null;
}

/** The term of the first project of `projects` that `content` names (see projectNamed); null when it names none. */
export const namedProject = (content: string, projects: readonly ProjectIdentity[]): string | null =>
  projectNamed(content, projects)?.term ?? null;

/**
 * Why an agent's craft refuses a write from a project run: it is read in every project the agent works
 * on, so what names one of them belongs to its notes on that project or to the project's team memory.
 */
export const namesProjectRefusal = (term: string) =>
  `Not saved: this names a project ("${term}"), and scope=craft is read in every project you work on. Save it with scope=mine (your notes on this project) or scope=team (shared with the team) instead. scope=craft is only for methods, tools and lessons that hold in any project, never names of projects, clients or sites.`;

/** The run's project and every other project the agent works on, with what names each of them. */
export async function projectsOfAgent(
  agentId: string,
  projectId: string | null,
  /** Every project: the super agent's craft is read wherever it works, which is about all of them. */
  everyProject = false,
): Promise<ProjectIdentity[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      goals: projects.goals,
    })
    .from(projects)
    .leftJoin(projectAgents, and(eq(projectAgents.projectId, projects.id), eq(projectAgents.agentId, agentId)))
    .where(
      everyProject ? undefined : or(projectId ? eq(projects.id, projectId) : undefined, isNotNull(projectAgents.agentId)),
    );
  if (!rows.length) return [];
  const repos = await db
    .select({ projectId: projectRepos.projectId, host: projectRepos.host })
    .from(projectRepos)
    .where(
      inArray(
        projectRepos.projectId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    texts: [p.description, p.goals],
    repoHosts: repos.filter((r) => r.projectId === p.id).map((r) => r.host),
  }));
}

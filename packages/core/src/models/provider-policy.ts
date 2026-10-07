import { db, messages, type ModelRef, projects, tasks } from "@abotica/db";
import { and, eq, inArray, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { reportedProjects } from "../tasks/delegation-report";

/**
 * Which AI providers may see some data. A project's allowed providers restrict everything that
 * carries its data to them: its runs, the background jobs that summarize its work (journals,
 * consolidation, the digest), embeddings and voice transcription. `allowed` null: any provider.
 */
export type ProviderPolicy = { readonly allowed: readonly string[] | null };

/** Data outside projects, or of a project without a restriction. */
export const ANY_PROVIDER: ProviderPolicy = { allowed: null };

/** A project's policy; an empty list of allowed providers means no restriction. */
export const providerPolicyOf = (project: { allowedProviders: readonly string[] } | null): ProviderPolicy =>
  project?.allowedProviders.length ? { allowed: project.allowedProviders } : ANY_PROVIDER;

/** The policy of data mixed from several sources: only providers every source allows. */
export function combinePolicies(...policies: ProviderPolicy[]): ProviderPolicy {
  let allowed: readonly string[] | null = null;
  for (const policy of policies) {
    if (policy.allowed === null) continue;
    allowed = allowed === null ? policy.allowed : allowed.filter((p) => policy.allowed!.includes(p));
  }
  return allowed === null ? ANY_PROVIDER : { allowed };
}

export const providerAllowed = (policy: ProviderPolicy, provider: string): boolean =>
  policy.allowed === null || policy.allowed.includes(provider);

/** The models of the chain the policy allows, in order. */
export const allowedModelChain = (policy: ProviderPolicy, chain: ModelRef[]): ModelRef[] =>
  chain.filter((m) => providerAllowed(policy, m.provider));

/**
 * Whether every model of the chain is allowed. A fallback chain may serve from any of its models,
 * so content goes to a chain only when the whole chain may see it.
 */
export const allowsModelChain = (policy: ProviderPolicy, chain: ModelRef[]): boolean =>
  chain.every((m) => providerAllowed(policy, m.provider));

/** The chain has models, but the policy allows none of them. */
export const deniesEveryModel = (policy: ProviderPolicy, chain: ModelRef[]): boolean =>
  chain.length > 0 && allowedModelChain(policy, chain).length === 0;

/** The agent has models, but none from a provider the data may go to. */
export class NoAllowedProviderError extends UserError {
  constructor() {
    super("errors.run.noAllowedProvider");
  }
}

/**
 * The policy of data from all the given projects. A project that no longer exists allows nothing:
 * when in doubt, nothing is sent.
 */
export async function projectsProviderPolicy(projectIds: readonly string[]): Promise<ProviderPolicy> {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return ANY_PROVIDER;
  const rows = await db
    .select({ allowedProviders: projects.allowedProviders })
    .from(projects)
    .where(inArray(projects.id, ids));
  const missing: ProviderPolicy[] = rows.length < ids.length ? [{ allowed: [] }] : [];
  return combinePolicies(...rows.map(providerPolicyOf), ...missing);
}

/** The policy of one project's data; null for data outside projects. */
export const projectProviderPolicy = (projectId: string | null): Promise<ProviderPolicy> =>
  projectsProviderPolicy(projectId ? [projectId] : []);

/**
 * A conversation that received the results of delegated tasks holds their projects' data from then
 * on: the delegation reports given to its agent (not the ones withheld from it) stay in its history.
 */
export async function conversationProviderPolicy(conversationId: string | null): Promise<ProviderPolicy> {
  if (!conversationId) return ANY_PROVIDER;
  const reports = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), sql`${messages.metadata}->>'kind' = 'delegation-report'`));
  const { projectIds, unresolvedTaskIds } = reportedProjects(reports.map((r) => r.metadata));
  const looked = unresolvedTaskIds.length
    ? await db.select({ projectId: tasks.projectId }).from(tasks).where(inArray(tasks.id, unresolvedTaskIds))
    : [];
  return projectsProviderPolicy([...projectIds, ...looked.flatMap((t) => (t.projectId ? [t.projectId] : []))]);
}

/** The policy a run works under: its project's, narrowed by every project whose results its conversation holds. */
export async function runProviderPolicy(projectId: string | null, conversationId: string | null): Promise<ProviderPolicy> {
  const [project, conversation] = await Promise.all([
    projectProviderPolicy(projectId),
    conversationProviderPolicy(conversationId),
  ]);
  return combinePolicies(project, conversation);
}

/** Projects whose data must not reach the chain: their restriction does not allow every model of it. */
export async function projectsClosedTo(chain: ModelRef[]): Promise<Set<string>> {
  const rows = await db.select({ id: projects.id, allowedProviders: projects.allowedProviders }).from(projects);
  return new Set(rows.filter((p) => !allowsModelChain(providerPolicyOf(p), chain)).map((p) => p.id));
}

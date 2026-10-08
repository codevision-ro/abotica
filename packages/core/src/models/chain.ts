import { type agents, db, type ModelRef, projects } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import {
  type CatalogModel,
  getCatalog,
  isLocalProvider,
  isSubscriptionProviderId,
  PROVIDER_IDS,
  PROVIDERS,
  type ProviderId,
} from "./catalog";
import { type ModelRole, type RoleModelSettings, roleDefaultModels } from "./model-role";
import { isProviderConfigured } from "./providers";

type AgentModelFields = Pick<typeof agents.$inferSelect, "provider" | "model" | "fallbacks">;

/** True when the agent has no model of its own and follows the default from settings. */
export const usesDefaultModel = (agent: AgentModelFields) => !agent.provider || !agent.model;

/** The ordered model chain an agent runs on: its own, or its role's default from settings (see modelRole). */
export function resolveModelChain(agent: AgentModelFields, settings: RoleModelSettings, role: ModelRole): ModelRef[] {
  if (usesDefaultModel(agent)) return roleDefaultModels(settings, role);
  return [{ provider: agent.provider!, model: agent.model! }, ...agent.fallbacks];
}

/** Whether the agent leads at least one project, which makes it a manager (see modelRole). */
export async function managesProject(agentId: string): Promise<boolean> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.managerAgentId, agentId)).limit(1);
  return Boolean(row);
}

/** No model on the agent and no default model for its role in settings. */
export class NoModelError extends UserError {
  constructor() {
    super("errors.noModel");
  }
}

type AvailableProvider = { id: ProviderId; label: string; models: CatalogModel[] };

/** Providers that have credentials, with their tool-capable models, newest first. */
export async function availableProviders(): Promise<AvailableProvider[]> {
  const catalog = await getCatalog();
  const out: AvailableProvider[] = [];
  for (const id of PROVIDER_IDS) {
    if (!(await isProviderConfigured(id))) continue;
    const models = catalog
      .filter((m) => m.provider === id && m.toolCall)
      .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
    // Ollama and plans list their own models: they count only once they have some.
    if (!models.length && (isLocalProvider(id) || isSubscriptionProviderId(id))) continue;
    out.push({ id, label: PROVIDERS[id].label, models });
  }
  return out;
}

/** Throws a message listing the alternatives when a provider has no credentials (read by the model as a tool result). */
export async function assertProviderUsable(provider: string): Promise<void> {
  const available = await availableProviders();
  if (available.some((p) => p.id === provider)) return;
  const list = available.map((p) => p.id).join(", ") || "none";
  throw new Error(`Provider ${provider} is not connected (no API key or signed-in account). Available providers: ${list}.`);
}

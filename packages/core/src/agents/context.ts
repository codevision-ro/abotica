import {
  agentMcpServers,
  agentSkills,
  agents,
  conversations,
  db,
  mcpServers,
  projectAgents,
  projectMcpServers,
  projects,
  projectSkills,
  runs,
  skills,
} from "@abotica/db";
import { and, asc, eq, ne, sql } from "@abotica/db/orm";
import type { ManagedSandboxSession } from "@abotica/sandbox";
import type { UIMessage } from "ai";
import { contextMemories, recentJournals } from "../memory/memory";
import { availableProviders } from "../models/chain";
import { localeEnglishNames, UserError } from "@abotica/i18n";
import { type RunRepo, runRepos } from "../projects/repos";
import type { StoredMessage } from "../runs/run-messages";
import { type AppSettings, getSettings, settingsLocale } from "../platform/settings";
import { workspaceToolsOf } from "./tools/workspace";

export type Agent = typeof agents.$inferSelect;
export type Project = typeof projects.$inferSelect;
type SkillRef = { id: string; slug: string; name: string; description: string };
export type McpServer = typeof mcpServers.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;

export type RunContext = {
  run: typeof runs.$inferSelect;
  agent: Agent;
  /** The run's conversation; it may override the agent's model and reasoning effort. */
  conversation: Conversation | null;
  /** The project this run works in, if any: the only one whose memory, journals and tasks it sees. */
  project: Project | null;
  projectId: string | null;
  /** Projects the agent leads as their manager. */
  managedProjectIds: string[];
  /** Manages at least one project, so it may delegate within the projects it manages. */
  isManager: boolean;
  skills: SkillRef[];
  mcpServers: McpServer[];
  /** The project's git repositories, with their tokens; empty outside a project. */
  repos: RunRepo[];
  settings: AppSettings;
  /**
   * The run's sandbox workspace, set by the runner before tools and instructions are built; null
   * when no backend is available or the agent has no workspace tool. Opens on first use.
   */
  sandbox: ManagedSandboxSession | null;
};

export async function loadRunContext(runId: string): Promise<RunContext> {
  const run = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
  if (!run) throw new Error(`Run ${runId} not found`);
  const { agentId } = run;
  const agent = agentId ? await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.id, agentId) }) : undefined;
  if (!agent) throw new UserError("runs.errors.agentDeleted");

  const conversation = run.conversationId
    ? ((await db.query.conversations.findFirst({ where: (c, { eq }) => eq(c.id, run.conversationId!) })) ?? null)
    : null;

  const managedProjectIds = (
    await db.select({ id: projects.id }).from(projects).where(eq(projects.managerAgentId, agent.id))
  ).map((r) => r.id);
  // The super agent is global: it works on projects only through their managers.
  const project =
    run.projectId && !agent.isOrchestrator
      ? ((await db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, run.projectId!) })) ?? null)
      : null;

  // Skills and MCP servers come from the agent plus the run's project, and the global servers.
  const skillRows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      description: skills.description,
      enabled: skills.enabled,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agent.id));
  const mcpRows = await db
    .select({ server: mcpServers })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.mcpServerId))
    .where(eq(agentMcpServers.agentId, agent.id));
  // Global servers reach every agent; an agent opts out by denying the server in its permissions.
  mcpRows.push(...(await db.select({ server: mcpServers }).from(mcpServers).where(eq(mcpServers.global, true))));
  if (project) {
    skillRows.push(
      ...(await db
        .select({
          id: skills.id,
          slug: skills.slug,
          name: skills.name,
          description: skills.description,
          enabled: skills.enabled,
        })
        .from(projectSkills)
        .innerJoin(skills, eq(skills.id, projectSkills.skillId))
        .where(eq(projectSkills.projectId, project.id))),
    );
    mcpRows.push(
      ...(await db
        .select({ server: mcpServers })
        .from(projectMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.id, projectMcpServers.mcpServerId))
        .where(eq(projectMcpServers.projectId, project.id))),
    );
  }

  // A skill test conversation adds the skill under test, even when it is disabled or not assigned.
  if (conversation?.testSkillId) {
    skillRows.push(
      ...(await db
        .select({
          id: skills.id,
          slug: skills.slug,
          name: skills.name,
          description: skills.description,
          enabled: sql<boolean>`true`,
        })
        .from(skills)
        .where(eq(skills.id, conversation.testSkillId))),
    );
  }

  // Sorted, since the queries have no order: skills and tools go into the prompt, and a different
  // order on the next run would miss the prompt cache.
  const uniqueBy = <T extends { slug: string }>(items: T[], key: (t: T) => string) =>
    [...new Map(items.map((i) => [key(i), i])).values()].sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    run,
    agent,
    conversation,
    project,
    projectId: project?.id ?? null,
    managedProjectIds,
    isManager: managedProjectIds.length > 0,
    skills: uniqueBy(
      skillRows.filter((s) => s.enabled),
      (s) => s.id,
    ).map(({ id, slug, name, description }) => ({ id, slug, name, description })),
    mcpServers: uniqueBy(
      mcpRows.map((r) => r.server).filter((s) => s.enabled),
      (s) => s.id,
    ),
    repos: project ? await runRepos(project.id) : [],
    settings: await getSettings(),
    sandbox: null,
  };
}

function formatDay(timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full" }).format(new Date());
}

/**
 * The line that opens a user message for the model. The time lives on each message rather than in
 * the system prompt: a prompt that changes every minute would defeat prompt caching and invalidate
 * the thinking blocks Anthropic binds to the conversation prefix.
 */
export function sentAtLine(sentAt: Date, timezone: string): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" });
  return `[Sent ${time.format(sentAt)}]`;
}

/** The history as the model gets it: every user message opens with the time it was sent. */
export function withSentTimes(history: StoredMessage[], timezone: string): UIMessage[] {
  return history.map(({ message, createdAt }) =>
    message.role === "user"
      ? { ...message, parts: [{ type: "text", text: sentAtLine(createdAt, timezone) }, ...message.parts] }
      : message,
  );
}

type TeamMember = { id: string; slug: string; name: string; role: string };

/** The enabled agents on a project's team. */
async function projectTeam(projectId: string): Promise<TeamMember[]> {
  return db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, role: agents.role })
    .from(projectAgents)
    .innerJoin(agents, eq(agents.id, projectAgents.agentId))
    .where(and(eq(projectAgents.projectId, projectId), eq(agents.enabled, true)))
    .orderBy(asc(agents.name));
}

const memberLine = (m: TeamMember) => `- ${m.name} (${m.slug})${m.role ? `: ${m.role}` : ""}`;

/** For the super agent: every open project and who leads it. */
async function projectsSection(): Promise<string> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, manager: agents.slug })
    .from(projects)
    .leftJoin(agents, eq(agents.id, projects.managerAgentId))
    .where(ne(projects.status, "archived"))
    .orderBy(asc(projects.name));
  return [
    "# Projects",
    "You are global: you never work inside a project and you do not see project memory. Each project has a manager who leads its team. For work in a project, delegate_task to that project's manager with the projectId: the manager plans it, splits it among the team, reviews it and reports back to you. Describe the outcome you want, not who on the team does each step.",
    rows.length ? "Projects (id, status, manager slug):" : "There are no projects yet.",
    ...rows.map(
      (p) =>
        `- ${p.name} (${p.id}, ${p.status}): ${p.manager ?? "no manager yet; nothing can be delegated in it until the user chooses one in the project's Team tab"}`,
    ),
  ].join("\n");
}

/** For an agent working in a project: its team, and how the manager leads it. */
async function teamSection(agent: Agent, project: Project): Promise<string> {
  const team = await projectTeam(project.id);
  const others = team.filter((m) => m.id !== agent.id);
  if (project.managerAgentId === agent.id) {
    return [
      "# Your team",
      `You are the manager of ${project.name}. You answer in this project's conversations, plan the work, split it into tasks for the team, review what comes back and report.`,
      others.length
        ? ["Team members (name, slug, role):", ...others.map(memberLine)].join("\n")
        : "Nobody else is on the team yet: do the work yourself, or tell whoever asked which specialist the project needs.",
      [
        "How you work:",
        "- Do small things yourself: a quick answer, a short edit, a lookup. Every delegation costs extra model calls and time, so delegate only work that needs a team member's skills or is big enough to split.",
        "- Delegate with delegate_task, only to the members above, with a complete brief: they do not see this conversation. Independent pieces can go to several members at once.",
        "- After delegating, end your turn. Results arrive here as an automatic notice: review them against what was asked, send back what is incomplete and mark done what is complete.",
        "- Report to whoever asked: the user in a conversation; when you work on a task, the task's output (task_update with status 'review'), which goes to the agent that gave you the task.",
        "- Save what the team should know about this project (decisions, conventions, facts) to project memory.",
      ].join("\n"),
    ].join("\n\n");
  }
  const manager = team.find((m) => m.id === project.managerAgentId);
  return [
    "# Your team",
    `You are part of the ${project.name} team. ${manager ? `The manager is ${manager.name} (${manager.slug}): it gives you tasks and reviews your work.` : "The project has no manager yet."}`,
    others.length ? ["Team members (name, slug, role):", ...others.map(memberLine)].join("\n") : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Tools left out of the request until the agent loads them with tool_search, by where they come from. */
export type DeferredToolGroup = { source: string; names: string[] };

/** The system prompt: agent persona, environment, memory, journals, skills, tools and rules. */
export async function buildInstructions(ctx: RunContext, deferredTools: DeferredToolGroup[] = []): Promise<string> {
  const { agent, project, settings } = ctx;
  // Memory and journals of the run's project only, never of the agent's other projects.
  const memory = await contextMemories(agent.id, ctx.projectId);
  const journals = await recentJournals(agent.id, ctx.projectId, settings.journalDays);
  const managed =
    !project && ctx.managedProjectIds.length
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.managerAgentId, agent.id))
      : [];

  const language = localeEnglishNames[settingsLocale(settings)];
  const sections: string[] = [];
  sections.push(agent.systemPrompt.trim() || `You are ${agent.name}, ${agent.role}.`);

  sections.push(
    [
      "# Context",
      `- Your name: ${agent.name} (${agent.slug})${agent.role ? `, role: ${agent.role}` : ""}`,
      `- Today: ${formatDay(settings.timezone)} (${settings.timezone}). Each user message starts with a [Sent ...] line: the time it was sent, added by the platform.`,
      `- Trigger: ${ctx.run.trigger}`,
      project ? `- Current project: ${project.name} (id ${project.id})` : null,
      project?.description ? `- Project description: ${project.description}` : null,
      project?.goals ? `- Project goals: ${project.goals}` : null,
      managed.length
        ? `- Projects you manage: ${managed.map((p) => `${p.name} (${p.id})`).join(", ")}. Work for one of them belongs in that project: name it with projectId when you delegate.`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const memoryLines: string[] = [];
  if (memory.project.length) memoryLines.push("## Project", ...memory.project.map((m) => `- ${m.content}`));
  if (memory.agent.length) memoryLines.push("## Yours (learned)", ...memory.agent.map((m) => `- ${m.content}`));
  if (memory.global.length) memoryLines.push("## Global", ...memory.global.map((m) => `- ${m.content}`));
  if (memoryLines.length) {
    sections.push(
      [
        "# Memory",
        "If entries contradict each other, the priority is: project > yours > global, and newer beats older.",
        ...memoryLines,
      ].join("\n"),
    );
  }

  if (journals.length) {
    sections.push(
      [
        `# Your journal for the last ${settings.journalDays} days`,
        ...journals.map((j) => `## ${j.day}\n${j.summary}`),
      ].join("\n"),
    );
  }

  if (agent.isOrchestrator) sections.push(await projectsSection());
  else if (project) sections.push(await teamSection(agent, project));

  if (agent.isOrchestrator) {
    const available = await availableProviders();
    const defaults = settings.defaultModels.map((m) => `${m.provider}/${m.model}`).join(" -> ") || "not set";
    sections.push(
      [
        "# Available models",
        `Default model (primary, then fallbacks): ${defaults}. New agents use it unless you pick something else.`,
        available.length
          ? "Providers with a configured API key (newest models):"
          : "No provider has an API key configured.",
        ...available.map(
          (p) =>
            `- ${p.id}: ${p.models
              .slice(0, 6)
              .map((m) => m.id)
              .join(", ")}`,
        ),
        "Do not use other providers: they have no key and runs would fail.",
      ].join("\n"),
    );
  }

  if (ctx.skills.length) {
    sections.push(
      [
        "# Skills",
        "You have access to these skills. When one fits, load it with skill_read before you start working.",
        "skill_read returns SKILL.md and the list of the skill's other files; when the instructions point to one of them, read it with skill_read and its path.",
        ...ctx.skills.map((s) => `- ${s.slug}: ${s.name}. ${s.description}`),
      ].join("\n"),
    );
  }

  if (deferredTools.length) {
    sections.push(
      [
        "# More tools",
        "These tools are available but not loaded. When a task needs one, load it with tool_search (exact names, or keywords) and call it on your next step.",
        ...deferredTools.map((g) => `- ${g.source}: ${g.names.join(", ")}`),
      ].join("\n"),
    );
  }

  const workspaceTools = workspaceToolsOf(agent);
  if (workspaceTools.length) {
    sections.push(
      ctx.sandbox
        ? ["# Workspace", ctx.sandbox.description, `- Workspace tools: ${workspaceTools.join(", ")}.`].join("\n")
        : [
            "# Workspace",
            "No sandbox is available on this server, so you cannot run commands or create files in this run. If the user asks for that, explain that an administrator can enable it in Settings > Sandbox.",
          ].join("\n"),
    );
  }

  sections.push(
    [
      "# Rules",
      "- Reply in the language the user writes in.",
      `- When there is no user message to match (scheduled runs, tasks, webhooks, delegated work), write in ${language}.`,
      "- Be concise. Report results, not the process.",
      "- Never use the em dash or the en dash: use a plain hyphen, a colon, or rephrase. Use straight quotes only.",
      "- If an action is not approved, do not retry it; explain and suggest something else.",
      "- Save to memory only durable information (preferences, decisions, facts), not intermediate steps.",
      agent.isOrchestrator
        ? "- You are the orchestrator: the single point of contact with the user. Break requests into clear tasks and delegate them: work in a project to its manager, other work to the right agent (agent_list, then delegate_task). Do not do a specialist's work yourself if one exists. Track progress and report back."
        : null,
      agent.isOrchestrator
        ? "- After delegating, tell the user the work is underway and end your turn. When the delegated tasks finish, their results arrive in this conversation as an automatic notice and you report them; do not poll for them."
        : null,
      '- Messages that start with "[Automatic notice from Abotica" come from the platform, not from the user.',
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return sections.join("\n\n");
}

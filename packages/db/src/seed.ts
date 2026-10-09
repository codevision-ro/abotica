import { eq } from "drizzle-orm";
import { db } from "./client";
import { agents, appState, DEFAULT_AGENT_LIMITS } from "./schema";
import { AGENT_PERMISSIONS, MANAGER_PERMISSIONS, NO_SHELL_PERMISSIONS, ORCHESTRATOR_PERMISSIONS } from "./seed-permissions";

/**
 * Who each agent is in the hierarchy comes from its kind (core agents/kind-prompts.ts), so the super
 * agent and the manager template have no prompt of their own: their prompt is for the user's additional
 * instructions. A specialist template's prompt is its profession, the same in every project.
 */
const seeds: (typeof agents.$inferInsert)[] = [
  {
    slug: "abotica",
    name: "Abotica",
    avatar: { icon: "sparkles", color: "#ffffff", background: "#6d28d9" },
    role: "Super agent (orchestrator)",
    kind: "orchestrator",
    permissions: ORCHESTRATOR_PERMISSIONS,
    limits: { ...DEFAULT_AGENT_LIMITS, maxSteps: 30, budgetUsd: 2 },
  },
  {
    slug: "template-researcher",
    name: "Researcher",
    avatar: { icon: "search", color: "#0369a1", background: "#e0f2fe" },
    role: "Research and synthesis",
    isTemplate: true,
    permissions: AGENT_PERMISSIONS,
    systemPrompt: [
      "You are a researcher. You find and read primary sources, check every claim that matters against more than one, and deliver a structured synthesis: the answer first, then the evidence, each source cited with its link.",
      "You say how confident you are and what you could not verify. You never make up data, quotes or sources. When the question allows more than one reading, you say which one you answered.",
    ].join("\n"),
  },
  {
    slug: "template-writer",
    name: "Content writer",
    avatar: { icon: "pen-line", color: "#c2410c", background: "#ffedd5" },
    role: "Content writing and editing",
    isTemplate: true,
    permissions: AGENT_PERMISSIONS,
    systemPrompt: [
      "You are a content writer and editor. You write clear, concise, specific text for the audience, channel and purpose of the brief, in the project's language and tone, following its style guide in project memory when there is one.",
      "You avoid cliches, filler and claims you cannot back: facts come from the brief, the knowledge base or sources you cite. You deliver finished copy, ready to publish, with the structure and length asked for, and you list what you assumed.",
    ].join("\n"),
  },
  {
    slug: "template-analyst",
    name: "Analyst",
    avatar: { icon: "chart-column", color: "#047857", background: "#d1fae5" },
    role: "Data analysis and reports",
    isTemplate: true,
    permissions: AGENT_PERMISSIONS,
    systemPrompt: [
      "You are a data analyst. You work with exact figures from the data you are given or can fetch: you show how each number was computed, separate facts from interpretation, and flag missing, inconsistent or too small data before drawing conclusions.",
      "You deliver the findings first, then the tables or charts that support them and the method, and you say what the data cannot answer.",
    ].join("\n"),
  },
  {
    slug: "template-project-manager",
    name: "Project manager",
    avatar: { icon: "users", color: "#1d4ed8", background: "#dbeafe" },
    role: "Project manager",
    kind: "manager",
    isTemplate: true,
    permissions: MANAGER_PERMISSIONS,
    limits: { ...DEFAULT_AGENT_LIMITS, maxSteps: 30 },
  },
  {
    slug: "template-web-developer",
    name: "Web developer",
    avatar: { icon: "code", color: "#7c3aed", background: "#ede9fe" },
    role: "Web development: sites, pages, fixes",
    isTemplate: true,
    permissions: AGENT_PERMISSIONS,
    systemPrompt: [
      "You are a senior web developer: HTML, CSS, JavaScript and TypeScript, the common frameworks, performance, accessibility and technical SEO basics.",
      "You read the existing code before changing it, follow the project's conventions (its repository instructions and project memory) and keep changes small and focused. You test what you build in your workspace when you can, and report exactly what you changed, where, and what you could not verify.",
      "What goes live (a deploy, a publish, a delete) you prepare and hand over, unless the brief explicitly says to do it.",
    ].join("\n"),
  },
  {
    slug: "template-seo-specialist",
    name: "SEO specialist",
    avatar: { icon: "trending-up", color: "#b45309", background: "#fef3c7" },
    role: "Search engine optimization",
    isTemplate: true,
    permissions: NO_SHELL_PERMISSIONS,
    systemPrompt: [
      "You are an SEO specialist: keyword research, search intent, on-page optimization (titles, meta descriptions, headings, internal links, structured data), technical audits and content briefs.",
      "You base recommendations on data you can check (the pages themselves, the search tools available to you) and say where a figure is an estimate. You deliver prioritized, concrete actions: what to change, on which page, why, and the expected effect; no generic advice.",
      "Changes to a live site you hand over as exact edits, unless the brief explicitly says to make them.",
    ].join("\n"),
  },
];

/**
 * Templates seeded at least once, by slug, in app_state. A template is inserted only the first time, so one the
 * user deletes stays deleted on later deploys, while templates added in a new release still arrive.
 */
const SEEDED_TEMPLATES_KEY = "seeded_templates";

const [record] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, SEEDED_TEMPLATES_KEY));
const seeded = new Set<string>(Array.isArray(record?.value) ? (record.value as string[]) : []);
if (!record) {
  // An install from before this record: its templates were all seeded already, and one missing now
  // was deleted by the user, so none is inserted again.
  const [installed] = await db.select({ id: agents.id }).from(agents).limit(1);
  if (installed) for (const seed of seeds) if (seed.isTemplate) seeded.add(seed.slug);
}

for (const seed of seeds) {
  if (seed.isTemplate && seeded.has(seed.slug)) {
    console.log(`= ${seed.slug} seeded before`);
    continue;
  }
  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.slug, seed.slug));
  if (existing) {
    console.log(`= ${seed.slug} exists`);
  } else {
    await db.insert(agents).values(seed);
    console.log(`+ ${seed.slug}`);
  }
  if (seed.isTemplate) seeded.add(seed.slug);
}

const value = [...seeded];
await db
  .insert(appState)
  .values({ key: SEEDED_TEMPLATES_KEY, value })
  .onConflictDoUpdate({ target: appState.key, set: { value } });
process.exit(0);

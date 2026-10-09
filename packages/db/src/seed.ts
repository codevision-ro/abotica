import { eq, inArray } from "drizzle-orm";
import { db } from "./client";
import { agents, appState } from "./schema";
import { ORCHESTRATOR_PERMISSIONS } from "./seed-permissions";
import { AGENT_TEMPLATES, RETIRED_TEMPLATES } from "./templates";
import { limits } from "./templates/_shared";

/**
 * The super agent and the agent templates (templates/, one file per domain). Who each agent is in the
 * hierarchy comes from its kind (core agents/kind-prompts.ts), so the super agent has no prompt of its own:
 * its prompt is for the user's additional instructions.
 */
const seeds: (typeof agents.$inferInsert)[] = [
  {
    slug: "abotica",
    name: "Abotica",
    avatar: { icon: "sparkles", color: "#ffffff", background: "#6d28d9" },
    role: "Super agent (orchestrator)",
    kind: "orchestrator",
    permissions: ORCHESTRATOR_PERMISSIONS,
    limits: limits(150, 120),
  },
  ...AGENT_TEMPLATES.map((template) => ({ ...template, isTemplate: true })),
];

/** The fields a seeded template keeps in step with its definition while the user has not edited it. */
const TEMPLATE_FIELDS = [
  "name",
  "role",
  "avatar",
  "kind",
  "systemPrompt",
  "reasoningEffort",
  "permissions",
  "limits",
] as const;

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

/** Key order does not count: jsonb stores an object's keys in its own order. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

for (const seed of seeds) {
  const [existing] = await db.select().from(agents).where(eq(agents.slug, seed.slug));
  if (existing) {
    // A template still at its first version was never edited: it follows its definition. Edits made a
    // new version, and the user's version wins.
    if (seed.isTemplate && existing.isTemplate && existing.version === 1) {
      const next = Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, seed[f] ?? agents[f].default]));
      if (TEMPLATE_FIELDS.some((f) => !sameJson(existing[f], next[f]))) {
        await db.update(agents).set(next).where(eq(agents.id, existing.id));
        console.log(`~ ${seed.slug} updated`);
      } else console.log(`= ${seed.slug} current`);
    } else console.log(`= ${seed.slug} exists`);
  } else if (seed.isTemplate && seeded.has(seed.slug)) {
    console.log(`= ${seed.slug} deleted by the user`);
  } else {
    await db.insert(agents).values(seed);
    console.log(`+ ${seed.slug}`);
  }
  if (seed.isTemplate) seeded.add(seed.slug);
}

const retired = await db
  .select({ id: agents.id, slug: agents.slug, isTemplate: agents.isTemplate, version: agents.version })
  .from(agents)
  .where(inArray(agents.slug, RETIRED_TEMPLATES));
const unedited = retired.filter((a) => a.isTemplate && a.version === 1);
if (unedited.length) {
  await db.delete(agents).where(
    inArray(
      agents.id,
      unedited.map((a) => a.id),
    ),
  );
  for (const a of unedited) console.log(`- ${a.slug} retired`);
}

const value = [...seeded];
await db
  .insert(appState)
  .values({ key: SEEDED_TEMPLATES_KEY, value })
  .onConflictDoUpdate({ target: appState.key, set: { value } });
process.exit(0);

"use server";

import * as core from "@abotica/core";
import { SKILL_DESCRIPTION_MAX_LENGTH, SKILL_NAME_MAX_LENGTH, VERSION_NOTE_MAX_LENGTH } from "@abotica/core/limits";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

const slug = z
  .string()
  .trim()
  .min(1, "skills.validation.slugRequired")
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "skills.validation.slugFormat");

const file = z.object({ path: z.string().min(1).max(255), content: z.string() });

const skillInput = z.object({
  name: z.string().trim().min(1, "skills.validation.nameRequired").max(SKILL_NAME_MAX_LENGTH),
  slug,
  description: z.string().trim().max(SKILL_DESCRIPTION_MAX_LENGTH).default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  files: z.array(file).min(1, "skills.files.missingSkillMd"),
  enabled: z.boolean().default(true),
  agentIds: z.array(z.uuid()).default([]),
  projectIds: z.array(z.uuid()).default([]),
});

const sourceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skills.sh"), id: z.string().min(3).max(300) }),
  z.object({
    kind: z.literal("github"),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    ref: z.string().max(200).optional(),
    path: z.string().max(500).optional(),
  }),
]);

function revalidateSkill(id?: string) {
  revalidatePath("/skills");
  if (id) revalidatePath(`/skills/${id}`);
}

async function insertSkill(input: Parameters<typeof core.createSkill>[0]) {
  const skill = await core.createSkill(input);
  revalidateSkill();
  return { id: skill.id };
}

export const createSkill = action(skillInput, insertSkill);

/** A folder imported by hand (zip, folder, .md): the slug comes from the name, made unique. */
export const importSkill = action(skillInput.omit({ slug: true }), insertSkill);

export const updateSkill = action(
  skillInput.partial().extend({ id: z.uuid(), note: z.string().trim().max(VERSION_NOTE_MAX_LENGTH).optional() }),
  async ({ id, note, ...change }) => {
    const result = await core.updateSkill(id, change, { note });
    revalidateSkill(id);
    return { version: result.version, changed: result.changed };
  },
);

export const setSkillEnabled = action(z.object({ id: z.uuid(), enabled: z.boolean() }), async ({ id, enabled }) => {
  await core.setSkillEnabled(id, enabled);
  revalidateSkill(id);
  return enabled;
});

export const deleteSkill = action(z.object({ id: z.uuid() }), async ({ id }) => {
  await core.deleteSkill(id);
  revalidateSkill();
  return null;
});

export const restoreSkillVersion = action(
  z.object({ id: z.uuid(), version: z.number().int().min(1) }),
  async ({ id, version }) => {
    const result = await core.restoreSkillVersion(id, version);
    revalidateSkill(id);
    return { version: result.version };
  },
);

export const searchSkillsSh = action(z.object({ query: z.string().max(200) }), ({ query }) => core.searchSkillsSh(query));

/** A pasted link: one skill to preview, or the skills found there to pick from. */
export const resolveSkillUrl = action(z.object({ url: z.string().trim().min(1).max(500) }), ({ url }) =>
  core.resolveSkillUrl(url),
);

/** The full folder of a remote skill, for the preview before installing. */
export const fetchSkillPreview = action(z.object({ ref: sourceRef }), ({ ref }) => core.fetchSkill(ref));

export const installSkill = action(
  z.object({ ref: sourceRef, expectedHash: z.string().max(128).optional() }),
  async ({ ref, expectedHash }) => {
    const skill = await core.installSkill(ref, { expectedHash });
    revalidateSkill();
    return { id: skill.id };
  },
);

export const checkSkillUpdate = action(z.object({ id: z.uuid() }), ({ id }) => core.checkSkillUpdate(id));

export const syncSkill = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const result = await core.syncSkillFromSource(id);
  revalidateSkill(id);
  return { version: result.version, changed: result.changed };
});

export const startSkillTest = action(
  z.object({
    skillId: z.uuid(),
    agentId: z.uuid(),
    prompt: z.string().trim().min(1, "skills.validation.promptRequired").max(20_000),
  }),
  async (input) => ({ conversationId: await core.startSkillTest(input) }),
);

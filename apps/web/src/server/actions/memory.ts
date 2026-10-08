"use server";

import {
  approveMemories as approveMemoryRows,
  createMemory as createMemoryRow,
  deleteMemory as deleteMemoryRow,
  rejectMemories as rejectMemoryRows,
  restoreMemory as restoreMemoryRow,
  setMemoryPinned as setMemoryPinnedRow,
  updateMemory as updateMemoryRow,
} from "@abotica/core";
import { MEMORY_MAX_LENGTH } from "@abotica/core/limits";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

const content = z
  .string()
  .trim()
  .min(1, "memory.validation.contentRequired")
  .max(MEMORY_MAX_LENGTH, "memory.validation.contentTooLong");

/** Set on an agent's or a project's page: entries of other owners are refused there. */
const owner = z.union([z.object({ agentId: z.uuid() }), z.object({ projectId: z.uuid() })]).optional();

export type MemoryOwner = NonNullable<z.infer<typeof owner>>;

function revalidateMemory(target?: MemoryOwner) {
  revalidatePath("/memory");
  if (target && "agentId" in target) revalidatePath(`/agents/${target.agentId}`);
  if (target && "projectId" in target) revalidatePath(`/projects/${target.projectId}`, "layout");
}

export const createMemory = action(
  z
    .object({
      scope: z.enum(["global", "project", "agent"]),
      projectId: z.uuid().nullish(),
      agentId: z.uuid().nullish(),
      content,
    })
    .refine((v) => v.scope !== "project" || !!v.projectId, {
      message: "memory.validation.chooseProject",
      path: ["projectId"],
    })
    .refine((v) => v.scope !== "agent" || !!v.agentId, { message: "memory.validation.chooseAgent", path: ["agentId"] }),
  async ({ scope, projectId, agentId, content }) => {
    // The user writes it: a project entry has no agent author, an agent entry belongs to its agent (with a
    // project: the agent's note on that project, read only in its runs there).
    const row = await createMemoryRow({
      scope,
      content,
      projectId: scope === "global" ? null : (projectId ?? null),
      agentId: scope === "agent" ? agentId : null,
      source: "manual",
      origin: "owner",
    });
    revalidateMemory(
      row.scope === "agent" && row.agentId
        ? { agentId: row.agentId }
        : row.projectId
          ? { projectId: row.projectId }
          : undefined,
    );
    // An agent's note also shows on its project's page.
    if (row.scope === "agent" && row.projectId) revalidateMemory({ projectId: row.projectId });
    return { id: row.id };
  },
);

export const updateMemory = action(z.object({ id: z.uuid(), content, owner }), async ({ id, content, owner }) => {
  await updateMemoryRow(id, content, { owner });
  revalidateMemory(owner);
});

export const setMemoryPinned = action(
  z.object({ id: z.uuid(), pinned: z.boolean(), owner }),
  async ({ id, pinned, owner }) => {
    await setMemoryPinnedRow(id, pinned, { owner });
    revalidateMemory(owner);
  },
);

/** Makes an entry a newer one replaced current again (agents read it again); the newer one stays. */
export const restoreMemory = action(z.object({ id: z.uuid(), owner }), async ({ id, owner }) => {
  await restoreMemoryRow(id, { owner });
  revalidateMemory(owner);
});

export const deleteMemory = action(z.object({ id: z.uuid(), owner }), async ({ id, owner }) => {
  await deleteMemoryRow(id, { owner });
  revalidateMemory(owner);
});

const review = z.object({ ids: z.array(z.uuid()).min(1), owner });

export const approveMemories = action(review, async ({ ids, owner }) => {
  const changed = await approveMemoryRows(ids, { owner });
  revalidateMemory(owner);
  return { count: changed.length };
});

export const rejectMemories = action(review, async ({ ids, owner }) => {
  const removed = await rejectMemoryRows(ids, { owner });
  revalidateMemory(owner);
  return { count: removed.length };
});

"use server";

import {
  addProjectRepo as addRepo,
  deleteProjectRepo as deleteRepo,
  type ProjectRepo,
  recheckProjectRepo as recheckRepo,
  REPO_PROVIDERS,
} from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

const uuid = z.string().uuid();
const token = z.string().trim().min(1, "repos.validation.tokenRequired").max(1_000);
const repoRef = z.object({ id: uuid, projectId: uuid });

const revalidate = (projectId: string) => revalidatePath(`/projects/${projectId}`);

export const addProjectRepo = action(
  z.object({
    projectId: uuid,
    url: z.string().trim().min(1, "repos.errors.invalidUrl").max(500),
    token,
    provider: z.enum(REPO_PROVIDERS).nullable().default(null),
    name: z.string().trim().max(64).nullable().default(null),
  }),
  async (input): Promise<ProjectRepo> => {
    const repo = await addRepo(input);
    revalidate(input.projectId);
    return repo;
  },
);

/** Checks the repo again; with `token`, replaces the stored one once the new one works. */
export const recheckProjectRepo = action(
  repoRef.extend({ token: token.nullable().default(null) }),
  async (input): Promise<ProjectRepo> => {
    const repo = await recheckRepo(input);
    revalidate(input.projectId);
    return repo;
  },
);

export const deleteProjectRepo = action(repoRef, async (input) => {
  await deleteRepo(input);
  revalidate(input.projectId);
});

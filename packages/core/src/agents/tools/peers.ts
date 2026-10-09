/**
 * Work across the team: a specialist asking a colleague for help, a manager adding a specialist to its
 * team, the super agent doing a small step inside a project itself.
 */
import { tool } from "ai";
import { z } from "zod";
import { FILE_MAX_BYTES } from "../../platform/limits";
import { blankToUndefined, optionalId, type ToolFactory } from "./shared";

/** Returned until the mechanism behind the tool is in place. */
const NOT_IMPLEMENTED = { error: "not implemented yet" } as const;

export const peerTools: Record<string, ToolFactory> = {
  ask_colleague: () =>
    tool({
      description:
        "Ask another specialist on your team for what they know or have. They answer as a small task of their own; the answer comes back here as a notice. Go on with what does not depend on it meanwhile.",
      inputSchema: z.object({
        agentSlug: z.string(),
        question: z.string().trim().min(1),
        files: z
          .preprocess(blankToUndefined, z.array(z.string().trim().min(1)).default([]))
          .describe(`Workspace paths of files they need to answer, at most ${FILE_MAX_BYTES / (1024 * 1024)} MB each`),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),

  team_add: () =>
    tool({
      description:
        "Add an existing specialist (agent_list) to the team of a project you lead, so you can delegate to them.",
      inputSchema: z.object({
        agentSlug: z.string(),
        projectId: optionalId().describe("Leave out for the project of this run"),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),

  work_in_project: () =>
    tool({
      description:
        "Do a small step inside a project yourself (a lookup, a one-line change), with the project's workspace, repositories and team memory. It runs as a task of yours in the project; the result comes back here as a notice.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        title: z.string().trim().min(1),
        brief: z.string().trim().min(1).describe("What to do, complete: the run does not see this conversation"),
      }),
      execute: async () => NOT_IMPLEMENTED,
    }),
};

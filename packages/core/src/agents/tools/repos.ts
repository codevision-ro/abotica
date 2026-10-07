import { tool } from "ai";
import { z } from "zod";
import { openPullRequest } from "../../projects/repo-api";
import { blankToUndefined, errorResult, optionalText, type ToolFactory } from "./shared";

export const repoTools: Record<string, ToolFactory> = {
  repo_open_pr: (ctx) =>
    tool({
      description:
        "Open a pull request (GitHub) or merge request (GitLab) for a branch you pushed with git push. When one is already open for the branch, its link comes back instead. Give the link to whoever asked for the work.",
      inputSchema: z.object({
        repo: z.string().trim().min(1).describe("The repository's folder name under repos/."),
        branch: z.string().trim().min(1).describe("The pushed branch with the changes."),
        title: z.string().trim().min(1).max(250),
        body: z
          .preprocess(blankToUndefined, z.string().max(60_000).default(""))
          .describe("What changed and why, in Markdown."),
        base: optionalText().describe("Branch to merge into; the repository's default branch when left out."),
        draft: z.preprocess(blankToUndefined, z.boolean().default(false)),
      }),
      execute: async ({ repo: name, branch, title, body, base, draft }) => {
        const repo = ctx.repos.find((r) => r.name === name);
        if (!repo) {
          return {
            error: `No repository ${name} in this project. Repositories: ${ctx.repos.map((r) => r.name).join(", ")}.`,
          };
        }
        const target = base?.trim() || repo.defaultBranch;
        if (branch === target) {
          return {
            error: `${branch} is the branch to merge into. Commit on another branch, push it, and open the pull request from it.`,
          };
        }
        try {
          const pull = await openPullRequest(repo, { branch, base: target, title, body, draft });
          return { url: pull.url, number: pull.number, created: pull.created, branch, base: target };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
};

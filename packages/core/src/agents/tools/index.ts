import { type Tool, tool, type ToolSet } from "ai";
import { z } from "zod";
import { readSkillForAgent } from "../../skills/skills";
import type { RunContext } from "../context";
import { builtinPermission } from "../permissions";
import { redactSecrets } from "../redact";
import { agentTools } from "./agents";
import { automationTools } from "./automation";
import { TOOL_CATALOG } from "./tool-catalog";
import { memoryTools } from "./memory";
import { previewTools } from "./previews";
import { projectTools } from "./projects";
import { repoTools } from "./repos";
import { runTools } from "./runs";
import type { ToolFactory } from "./shared";
import { taskTools } from "./tasks";
import { webTools } from "./web";
import { workspaceTools } from "./workspace";

const factories: Record<string, ToolFactory> = {
  ...memoryTools,
  ...taskTools,
  ...webTools,
  ...projectTools,
  ...agentTools,
  ...runTools,
  ...automationTools,
  ...workspaceTools,
  ...repoTools,
  ...previewTools,
};

/** Lets an agent load a skill listed in its prompt: SKILL.md first, then the files it points to. */
function skillReadTool(ctx: RunContext) {
  return tool({
    description:
      "Load a skill from your skill list. Without a path it returns SKILL.md and the list of the skill's other files; with a path (e.g. references/api.md) it returns that file.",
    inputSchema: z.object({
      slug: z.string(),
      path: z.string().optional().describe("A file of the skill, relative to its folder. Leave out for SKILL.md."),
    }),
    execute: async ({ slug, path }) => {
      const skill = ctx.skills.find((s) => s.slug === slug);
      if (!skill) return { error: `Skill ${slug} is not assigned to you` };
      return { slug, ...(await readSkillForAgent(skill.id, path)) };
    },
  });
}

/** The tool with the given secrets replaced in everything it returns. */
function redacting(original: Tool, secrets: string[]): Tool {
  const execute = original.execute;
  if (!execute || !secrets.length) return original;
  return {
    ...original,
    execute: async (input: unknown, options: Parameters<typeof execute>[1]) =>
      redactSecrets(await execute(input, options), secrets),
  } as Tool;
}

export function builtinTools(ctx: RunContext): ToolSet {
  const out: ToolSet = {};
  const opts = { isOrchestrator: ctx.agent.isOrchestrator, isManager: ctx.isManager };
  // Workspace commands run with the repositories' tokens in their environment.
  const secrets = ctx.repos.map((r) => r.token);
  // Denied tools are left out entirely, so the model never sees them.
  for (const { name, group, needsRepos } of TOOL_CATALOG) {
    const factory = factories[name];
    if (!factory || builtinPermission(ctx.agent.permissions, name, opts) === "deny") continue;
    // Without a sandbox for this run the workspace tools could only fail; the prompt explains why.
    if (group === "workspace" && !ctx.sandbox) continue;
    if (needsRepos && !ctx.repos.length) continue;
    out[name] = group === "workspace" ? redacting(factory(ctx), secrets) : factory(ctx);
  }
  if (ctx.skills.length) out.skill_read = skillReadTool(ctx);
  return out;
}

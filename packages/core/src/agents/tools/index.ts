import { type Tool, tool, type ToolSet } from "ai";
import { z } from "zod";
import { findReadableSkill, readsSkills, skillReadDescription } from "../../skills/skill-access";
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

/**
 * Lets an agent load a skill listed in its prompt (SKILL.md first, then the files it points to), and the super
 * agent and managers read the skills of those they brief (see findReadableSkill).
 */
function skillReadTool(ctx: RunContext) {
  return tool({
    description: skillReadDescription(ctx),
    inputSchema: z.object({
      slug: z.string(),
      path: z.string().optional().describe("A file of the skill, relative to its folder. Leave out for SKILL.md."),
    }),
    execute: async ({ slug, path }) => {
      const skill = await findReadableSkill(ctx, slug);
      if (!skill) {
        return {
          error:
            ctx.agent.kind === "specialist"
              ? `Skill ${slug} is not assigned to you`
              : `Skill ${slug} does not exist or is not one you may read`,
        };
      }
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
  // The tokens never enter the workspace; this catches one that got there another way (a URL saved with it).
  const secrets = ctx.repos.map((r) => r.token);
  // Denied tools are left out entirely, so the model never sees them.
  for (const { name, group, needsRepos } of TOOL_CATALOG) {
    const factory = factories[name];
    if (!factory || builtinPermission(ctx.agent.permissions, name, ctx.agent) === "deny") continue;
    // Without a sandbox for this run the workspace tools could only fail; the prompt explains why.
    if (group === "workspace" && !ctx.sandbox) continue;
    if (needsRepos && !ctx.repos.length) continue;
    out[name] = group === "workspace" ? redacting(factory(ctx), secrets) : factory(ctx);
  }
  if (readsSkills(ctx)) out.skill_read = skillReadTool(ctx);
  return out;
}

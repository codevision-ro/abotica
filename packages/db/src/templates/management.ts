import { MANAGER_PERMISSIONS } from "../seed-permissions";
import { type AgentTemplate, limits } from "./_shared";

/**
 * Management: the manager every new project gets. No prompt: who a manager is and how it works comes from
 * its kind (core agents/kind-prompts.ts), and its own prompt is left for the user's additional instructions.
 */
export const MANAGEMENT_TEMPLATES: AgentTemplate[] = [
  {
    slug: "template-project-manager",
    name: "Project Manager",
    avatar: { icon: "users", color: "#1d4ed8", background: "#dbeafe" },
    role: "Project manager",
    kind: "manager",
    permissions: MANAGER_PERMISSIONS,
    limits: limits(40, 20, 2),
  },
];

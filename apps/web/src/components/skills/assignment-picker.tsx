import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";

/** Something a skill or MCP server can be assigned to: an agent (with its avatar) or a project. */
export type PickerOption = { id: string; name: string; hint: string; avatar?: AgentAvatarValue };

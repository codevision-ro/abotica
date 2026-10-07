import type { ToolInfo } from "@abotica/core/agents/tools/tool-catalog";
import { BrainIcon, GlobeIcon, ListTodoIcon, type LucideIcon, NetworkIcon, SquareTerminalIcon } from "lucide-react";

/** Icon of each built-in tool group, in the agent permissions and on tool calls in chat. */
export const TOOL_GROUP_ICONS: Record<ToolInfo["group"], LucideIcon> = {
  memory: BrainIcon,
  tasks: ListTodoIcon,
  web: GlobeIcon,
  workspace: SquareTerminalIcon,
  orchestration: NetworkIcon,
};

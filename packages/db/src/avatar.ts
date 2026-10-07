// No drizzle imports here: client components import this file.

/** Agent avatar: a Lucide icon name (kebab-case, e.g. "chart-column") and two hex colors. */
export type AgentAvatar = { icon: string; color: string; background: string };

export const DEFAULT_AGENT_AVATAR: AgentAvatar = { icon: "bot", color: "#6d28d9", background: "#ede9fe" };

const HEX = /^#[0-9a-f]{6}$/i;

/** Normalizes stored values, including the emoji strings older agent versions kept. */
export function toAgentAvatar(value: unknown): AgentAvatar {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_AVATAR;
  const v = value as Partial<Record<keyof AgentAvatar, unknown>>;
  return {
    icon: typeof v.icon === "string" && /^[a-z0-9-]{1,64}$/.test(v.icon) ? v.icon : DEFAULT_AGENT_AVATAR.icon,
    color: typeof v.color === "string" && HEX.test(v.color) ? v.color.toLowerCase() : DEFAULT_AGENT_AVATAR.color,
    background:
      typeof v.background === "string" && HEX.test(v.background)
        ? v.background.toLowerCase()
        : DEFAULT_AGENT_AVATAR.background,
  };
}

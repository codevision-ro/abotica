import { type AgentAvatar as AgentAvatarValue, DEFAULT_AGENT_AVATAR } from "@abotica/db/avatar";
import { type CSSProperties, createElement } from "react";
import { cn } from "@/lib/utils";
import { agentIcon } from "./agent-icons";

const SIZES = {
  xs: "size-5 rounded-md [&_svg]:size-3!",
  sm: "size-6 rounded-md [&_svg]:size-3.5!",
  md: "size-7 rounded-lg [&_svg]:size-4!",
  lg: "size-8 rounded-lg [&_svg]:size-4.5!",
  xl: "size-12 rounded-xl [&_svg]:size-6!",
  "2xl": "size-16 rounded-2xl [&_svg]:size-8!",
} as const;

type AgentAvatarSize = keyof typeof SIZES;

/** Relative luminance of a `#rrggbb` color, 0 (black) to 1 (white). */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * Colors for anything drawn in an avatar's colors. Pastel backgrounds glare on dark surfaces, so in
 * dark mode they become a tint of the icon color and the icon is lightened; solid ones stay as set.
 */
export function avatarColors({ color, background }: Pick<AgentAvatarValue, "color" | "background">) {
  return {
    style: { "--avatar-fg": color, "--avatar-bg": background } as CSSProperties,
    "data-tone": luminance(background) > 0.5 ? "light" : "solid",
    className:
      "bg-(--avatar-bg) text-(--avatar-fg) dark:data-[tone=light]:bg-[color-mix(in_oklch,var(--avatar-fg)_24%,transparent)] dark:data-[tone=light]:text-[color-mix(in_oklch,var(--avatar-fg),white_45%)]",
  };
}

/** The agent's icon on its background color; agents without one get the default robot. */
export function AgentAvatar({
  avatar,
  size,
  className,
}: {
  avatar: AgentAvatarValue | null | undefined;
  size: AgentAvatarSize;
  className?: string;
}) {
  const { icon, ...colors } = avatar ?? DEFAULT_AGENT_AVATAR;
  const tone = avatarColors(colors);
  return (
    <span
      aria-hidden
      style={tone.style}
      data-tone={tone["data-tone"]}
      className={cn(
        tone.className,
        "flex shrink-0 items-center justify-center shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        SIZES[size],
        className,
      )}
    >
      {createElement(agentIcon(icon), { strokeWidth: 2 })}
    </span>
  );
}

export function AgentName({ name, avatar }: { name: string; avatar?: AgentAvatarValue | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <AgentAvatar avatar={avatar} size="xs" />
      <span className="truncate">{name}</span>
    </span>
  );
}

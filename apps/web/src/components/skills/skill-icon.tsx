import { BlocksIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "size-7 rounded-lg [&_svg]:size-4",
  xl: "size-12 rounded-xl [&_svg]:size-6",
  "2xl": "size-16 rounded-2xl [&_svg]:size-8",
} as const;

/** Icon tile of a skill, in the same family as the MCP server tiles. */
export function SkillIcon({ size, className }: { size: keyof typeof SIZES; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-primary/8 text-primary shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:bg-primary/15 dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        SIZES[size],
        className,
      )}
    >
      <BlocksIcon />
    </span>
  );
}

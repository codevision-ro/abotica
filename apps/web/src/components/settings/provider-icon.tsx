import type { ProviderId } from "@abotica/core";
import { Aperture, Fish, HardDrive, type LucideIcon, Moon, Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";

/** A mark and a tint per provider, so cards and catalog chips are told apart at a glance. */
const PROVIDER_ICONS: Record<ProviderId, { icon: LucideIcon; tint: string }> = {
  anthropic: { icon: Sparkle, tint: "bg-orange-500/10 text-orange-600 dark:bg-orange-400/15 dark:text-orange-300" },
  openai: { icon: Aperture, tint: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300" },
  deepseek: { icon: Fish, tint: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300" },
  moonshot: { icon: Moon, tint: "bg-violet-500/10 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300" },
  ollama: { icon: HardDrive, tint: "bg-zinc-500/10 text-zinc-700 dark:bg-zinc-400/15 dark:text-zinc-300" },
};

const SIZES = {
  xs: "size-5 rounded-md [&_svg]:size-3!",
  lg: "size-10 rounded-xl [&_svg]:size-5!",
} as const;

export function ProviderIcon({ provider, size }: { provider: ProviderId; size: keyof typeof SIZES }) {
  const { icon: Icon, tint } = PROVIDER_ICONS[provider];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]",
        tint,
        SIZES[size],
      )}
    >
      <Icon />
    </span>
  );
}

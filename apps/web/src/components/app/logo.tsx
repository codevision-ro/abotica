import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-primary to-[color-mix(in_oklch,var(--primary),black_18%)] text-primary-foreground shadow-sm ring-1 ring-black/5 ring-inset dark:to-[color-mix(in_oklch,var(--primary),black_30%)] dark:ring-white/10",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="size-[55%]" aria-hidden>
        <path d="M16 3l3.4 9.6L29 16l-9.6 3.4L16 29l-3.4-9.6L3 16l9.6-3.4z" fill="currentColor" />
      </svg>
    </div>
  );
}

import { cn } from "@/lib/utils";

/**
 * The app mark: a white "a" with the "i" dot on the brand gradient, lighter in dark mode.
 * Sizes are `!` because the sidebar button sizes every svg inside it to 1rem.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-[28%] bg-linear-to-br from-[#6a49eb] to-[#4f36b4] text-white shadow-sm ring-1 ring-black/5 ring-inset dark:from-[#8f81ff] dark:to-[#6a49eb] dark:ring-white/10",
        className,
      )}
    >
      <svg viewBox="0 0 32 32" className="size-full!" aria-hidden>
        <circle cx="16" cy="18.8" r="6.1" fill="none" stroke="currentColor" strokeWidth="3.4" />
        <path d="M22.1 11.2V26.6" stroke="currentColor" strokeWidth="3.4" />
        <circle cx="22.1" cy="7.4" r="2.15" fill="currentColor" />
      </svg>
    </div>
  );
}

/**
 * "abotica" drawn in strokes, in the text color, with the "i" dot in the brand color. Size it by height:
 * next to the mark the brand uses 5/6 of the mark's height.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="-2 4 147 40" role="img" aria-label="Abotica" className={cn("h-5 w-auto! shrink-0", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="4">
        <circle cx="10" cy="30" r="8" />
        <path d="M18 20V40" />
        <path d="M27 7V40" />
        <circle cx="35" cy="30" r="8" />
        <circle cx="60" cy="30" r="8" />
        <path d="M79 13V40" />
        <path d="M74 22H85" />
        <path d="M92 20V40" />
        <path d="M114.95 24.65A8 8 0 1 0 114.95 35.35" />
        <circle cx="133" cy="30" r="8" />
        <path d="M141 20V40" />
      </g>
      <circle cx="92" cy="12.6" r="3" className="fill-[#6a49eb] dark:fill-[#8f81ff]" />
    </svg>
  );
}

/** The mark and the wordmark side by side, in the brand's proportions, for pages outside the app shell. */
export function LogoFull({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Logo className="size-11 shadow-md shadow-primary/20" />
      <Wordmark className="h-[37px]" />
    </div>
  );
}

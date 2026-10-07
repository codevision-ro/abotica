"use client";

import { CircleCheckIcon, CircleDashedIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { scrollToSection } from "./form-section";

/** Card of the right-hand summary rail on long forms; place it in a sticky column. */
export function SummaryRail({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-xs dark:bg-card/60", className)}>
      {children}
    </div>
  );
}

export function SummaryList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ul aria-label={label} className="-mx-2 flex flex-col">
      {children}
    </ul>
  );
}

/** Done: required part filled in. Todo: still missing. Info: a value with nothing to complete. */
export type SummaryStatus = "done" | "todo" | "info";

const STATUS_ICON: Record<SummaryStatus, React.ReactNode> = {
  done: (
    <CircleCheckIcon className="size-4 text-[color-mix(in_oklch,var(--success),black_15%)] dark:text-success" aria-hidden />
  ),
  todo: <CircleDashedIcon className="size-4 text-muted-foreground/70" aria-hidden />,
  info: (
    <span className="flex size-4 items-center justify-center" aria-hidden>
      <span className="size-1.5 rounded-full bg-muted-foreground/50" />
    </span>
  ),
};

/** One line of the rail: status, label and current value. Clicking scrolls to the section. */
export function SummaryItem({
  target,
  status,
  label,
  statusLabel,
  children,
  onSelect,
}: {
  /** Id of the form section to scroll to. */
  target: string;
  status: SummaryStatus;
  label: string;
  /** Spoken status for done/todo items, e.g. "complete". */
  statusLabel?: string;
  children?: React.ReactNode;
  onSelect?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onSelect?.();
          // Let an opening section render before measuring where it is.
          requestAnimationFrame(() => scrollToSection(target));
        }}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="shrink-0">{STATUS_ICON[status]}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {label}
            {statusLabel && <span className="sr-only">: {statusLabel}</span>}
          </span>
          {children && <span className="min-w-0 truncate text-xs text-muted-foreground">{children}</span>}
        </span>
      </button>
    </li>
  );
}

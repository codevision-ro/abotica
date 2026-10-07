"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type OptionCard<T extends string> = {
  value: T;
  icon: LucideIcon;
  title: React.ReactNode;
  /** Plain content only: the whole card is a label, so no links here. */
  description?: React.ReactNode;
};

/** A single choice shown as side-by-side cards; native radios underneath, so arrow keys work. */
export function OptionCards<T extends string>({
  name,
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  /** Radio group name, unique on the page. */
  name: string;
  value: T;
  onValueChange: (value: T) => void;
  options: OptionCard<T>[];
  /** Accessible name of the group. */
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2", className)}>
      {options.map(({ value: optionValue, icon: Icon, title, description }) => (
        <label
          key={optionValue}
          className="group/option flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 has-checked:border-primary/50 has-checked:bg-primary/5 has-checked:ring-1 has-checked:ring-primary/30 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:bg-input/20 dark:has-checked:bg-primary/10"
        >
          <input
            type="radio"
            name={name}
            value={optionValue}
            checked={value === optionValue}
            onChange={() => onValueChange(optionValue)}
            className="peer sr-only"
          />
          <Icon className="size-4 shrink-0 text-muted-foreground peer-checked:text-primary" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{title}</span>
            {description && <span className="text-xs text-muted-foreground">{description}</span>}
          </span>
          <span
            className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input peer-checked:border-primary peer-checked:bg-primary"
            aria-hidden
          >
            <span className="size-1.5 rounded-full bg-primary-foreground opacity-0 group-has-checked/option:opacity-100" />
          </span>
        </label>
      ))}
    </div>
  );
}

import { cva } from "class-variance-authority";
import { CheckIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Pill look shared by toggle chips and by links that act as a choice (e.g. "start from" rows). */
export const chipVariants = cva(
  "inline-flex h-8 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      selected: {
        true: "border-primary/40 bg-primary/8 font-medium text-foreground dark:border-primary/50 dark:bg-primary/15",
        false: "bg-background text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-input/20",
      },
    },
    defaultVariants: { selected: false },
  },
);

/** A toggle pill: check mark when on, plus sign when off. */
export function SelectableChip({
  selected,
  onSelectedChange,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange"> & {
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelectedChange(!selected)}
      className={cn(chipVariants({ selected }), className)}
      {...props}
    >
      {selected ? <CheckIcon className="text-primary" aria-hidden /> : <PlusIcon aria-hidden />}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

import type { LucideIcon } from "lucide-react";
import { useId } from "react";
import { SectionIcon, sectionCardClass } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/**
 * A section that is a single setting: icon, title and description on the left, the control on the right.
 * The control wraps below the text on narrow screens.
 */
export function InlineSection({
  titleId,
  icon,
  title,
  description,
  children,
  className,
}: {
  /** Id of the title, so the control can point at it with `aria-labelledby`. */
  titleId?: string;
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const fallbackId = useId();
  const id = titleId ?? fallbackId;
  return (
    <section
      aria-labelledby={id}
      className={cn(sectionCardClass, "flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3.5 sm:px-5", className)}
    >
      <SectionIcon icon={icon} />
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <h2 id={id} className="text-base leading-snug font-semibold tracking-tight">
          {title}
        </h2>
        {description && <div className="text-sm text-pretty text-muted-foreground">{description}</div>}
      </div>
      <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:shrink-0">{children}</div>
    </section>
  );
}

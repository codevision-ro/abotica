import type { LucideIcon } from "lucide-react";
import { SectionIcon, sectionCardClass } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/**
 * The card a memory or journal tab sits in: a header line (tinted icon, short explanation, controls on the
 * right), a hairline fading right, then flush content whose rows bring their own padding.
 */
export function MemoryPanel({
  icon,
  title,
  description,
  action,
  children,
  footer,
  className,
}: {
  icon?: LucideIcon;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Controls on the right of the header: filters or the group's bulk actions. */
  action?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(sectionCardClass, "min-w-0", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3 sm:px-5">
        {icon && <SectionIcon icon={icon} />}
        <div className="min-w-0 flex-1 basis-56 space-y-0.5">
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {description && <div className="text-sm text-pretty text-muted-foreground">{description}</div>}
        </div>
        {action && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 max-sm:w-full">{action}</div>}
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <div className="overflow-hidden rounded-b-2xl">{children}</div>
      {footer && <div className="border-t border-border/60 px-4 py-3 sm:px-5">{footer}</div>}
    </section>
  );
}

/** One-line empty state inside a panel, optionally followed by an action. */
export function PanelEmpty({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("px-4 py-5 text-sm text-muted-foreground sm:px-5", className)}>{children}</p>;
}

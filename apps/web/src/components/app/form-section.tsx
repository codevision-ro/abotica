"use client";

import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Scrolls a form section into view; sections carry `scroll-mt-*` so the sticky header does not cover them. */
export function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The quiet card every section sits in; the rail and nested lists keep their own, stronger borders. */
const SECTION_CARD =
  "scroll-mt-20 rounded-2xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40";

/** Hairline between a section's header and its content, fading out to the right. */
function SectionDivider() {
  return <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />;
}

function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/**
 * One titled block of a long form, in a subtle card: icon, title and description on top, the fields below.
 * `id` is the scroll target for summary rails and in-page links.
 */
export function FormSection({
  id,
  icon,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Secondary control on the right of the header, e.g. a bulk action. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn(SECTION_CARD, className)}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <SectionIcon icon={icon} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h2 id={`${id}-title`} className="text-base leading-snug font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <SectionDivider />
      <div className="flex flex-col gap-4 p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** A form section that starts closed and shows a one-line summary of its values instead. */
export function FormSectionCollapsible({
  id,
  icon,
  title,
  summary,
  open,
  onOpenChange,
  children,
  className,
}: {
  id: string;
  icon: LucideIcon;
  title: React.ReactNode;
  /** Current values in one line, shown while closed. */
  summary: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange} className={cn(SECTION_CARD, className)}>
      <section id={id} aria-labelledby={`${id}-title`}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/section flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:rounded-b-none sm:px-5"
          >
            <SectionIcon icon={icon} />
            <span className="min-w-0 flex-1 space-y-0.5">
              <span id={`${id}-title`} className="block text-base leading-snug font-semibold tracking-tight">
                {title}
              </span>
              <span className="block truncate text-sm text-muted-foreground group-data-[state=open]/section:hidden">
                {summary}
              </span>
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/section:rotate-180"
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SectionDivider />
          <div className="flex flex-col gap-6 p-4 sm:p-5">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** A labelled group inside a section, with an optional count and right-side action. */
export function FormSubsection({
  title,
  count,
  description,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  count?: number;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {title}
            {count !== undefined && count > 0 && (
              <span className="tabular ml-1.5 font-normal text-muted-foreground">{count}</span>
            )}
          </h3>
          {description && <p className="text-xs text-pretty text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

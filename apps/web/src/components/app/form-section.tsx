"use client";

import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { SectionDivider, SectionHeader, SectionIcon, sectionCardClass } from "@/components/app/section-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** Scrolls a form section into view; sections carry `scroll-mt-*` so the sticky header does not cover them. */
export function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The quiet card every section sits in; the rail and nested lists keep their own, stronger borders. */
const SECTION_CARD = `scroll-mt-20 ${sectionCardClass}`;

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
}: {
  id: string;
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Secondary control on the right of the header, e.g. a bulk action. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={SECTION_CARD}>
      <SectionHeader
        icon={icon}
        titleId={`${id}-title`}
        title={title}
        description={description}
        descriptionAs="p"
        action={action}
      />
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
}: {
  id: string;
  icon: LucideIcon;
  title: React.ReactNode;
  /** Current values in one line, shown while closed. */
  summary: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange} className={SECTION_CARD}>
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
}: {
  title: React.ReactNode;
  count?: number;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
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

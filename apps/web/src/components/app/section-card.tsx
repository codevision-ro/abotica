import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The quiet card of `FormSection`, for read-only blocks such as overview panels and lists with their own
 * actions. It has no client code, so server components can render it.
 */
export const sectionCardClass =
  "rounded-2xl border border-border/70 bg-card/70 shadow-[0_1px_2px_rgb(0_0_0/0.03)] dark:bg-card/40";

/** Tinted square behind a section or row icon. */
export function SectionIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/**
 * A titled card: icon, title and description on top, a hairline fading right, then the content.
 * `flush` drops the content padding, for lists whose rows bring their own.
 */
export function SectionCard({
  icon,
  title,
  count,
  description,
  action,
  flush,
  children,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  count?: number;
  description?: React.ReactNode;
  /** Controls on the right of the header, e.g. the tab's primary action. */
  action?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn(sectionCardClass, "min-w-0", className)}>
      {/* On phones the description runs under the action too, so a long one is not squeezed into a sliver. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3.5 sm:px-5">
        <SectionIcon icon={icon} className={cn(description && "row-[1/3]")} />
        <h2 id={id} className="col-start-2 row-start-1 text-base leading-snug font-semibold tracking-tight">
          {title}
          {count !== undefined && count > 0 && (
            <span className="tabular ml-1.5 text-sm font-normal text-muted-foreground">{count}</span>
          )}
        </h2>
        {action && (
          <div
            className={cn(
              "col-start-3 row-start-1 flex shrink-0 items-center justify-end gap-2",
              description && "sm:row-[1/3]",
            )}
          >
            {action}
          </div>
        )}
        {description && (
          <div className="col-[2/-1] row-start-2 text-sm text-pretty text-muted-foreground sm:col-[2/3]">{description}</div>
        )}
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <div className={cn(flush ? "overflow-hidden rounded-b-2xl" : "p-4 sm:p-5")}>{children}</div>
    </section>
  );
}

/** Rows inside a flush `SectionCard`. */
export function SectionList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn("divide-y divide-border/60", className)}>{children}</ul>;
}

/**
 * One row: media vertically centered next to a title and a muted subtitle, trailing content on the right.
 * With `href` the whole row is a link; otherwise the trailing slot can hold buttons.
 */
export function SectionRow({
  href,
  media,
  title,
  subtitle,
  trailing,
  className,
}: {
  href?: string;
  media?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const body = (
    <>
      {media}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </>
  );
  const rowClass = cn("flex min-w-0 items-center gap-3 px-4 py-3 sm:px-5", className);
  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={cn(
            rowClass,
            "transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={cn(rowClass, "transition-colors hover:bg-muted/30")}>{body}</div>
      )}
    </li>
  );
}

/** One-line empty state inside a flush `SectionCard`, optionally ending in an action link. */
export function SectionEmpty({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("px-4 py-4 text-sm text-muted-foreground sm:px-5", className)}>{children}</p>;
}

/** Inline link for `SectionEmpty` and similar one-liners. */
export function SectionEmptyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="underline underline-offset-2 hover:text-foreground">
      {children}
    </Link>
  );
}

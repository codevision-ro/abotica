import { ArrowUpRightIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { sectionCardClass, SectionIcon } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/**
 * One headline number of the cost report: tinted icon and label, the value, an optional muted hint. With
 * `href`, the tile opens the list behind the number (the runs).
 */
export function CostKpi({
  icon,
  label,
  value,
  hint,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <SectionIcon icon={icon} className="size-7 rounded-md" />
        <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-muted-foreground" title={label}>
          {label}
        </p>
        {href && (
          <ArrowUpRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </div>
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </>
  );
  const className = cn(sectionCardClass, "flex min-w-0 flex-col gap-3 p-4 sm:p-5");
  return href ? (
    <Link
      href={href}
      className={cn(
        className,
        "group transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50",
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

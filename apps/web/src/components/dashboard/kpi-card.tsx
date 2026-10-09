import { ArrowUpRightIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { sectionCardClass, SectionIcon } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/** One overview number: tinted icon and label on top, the value, then a muted line of context. */
export function KpiCard({
  label,
  value,
  icon,
  children,
  href,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  children?: React.ReactNode;
  href: string;
  tone?: "default" | "warning";
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        sectionCardClass,
        "group flex min-w-0 flex-col gap-3 p-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5",
        tone === "warning" && "border-warning/50 bg-warning/5 hover:bg-warning/10 dark:bg-warning/5",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <SectionIcon
          icon={icon}
          className={cn(
            "size-7 rounded-md",
            tone === "warning" &&
              "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:bg-warning/20 dark:text-warning",
          )}
        />
        <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-muted-foreground sm:line-clamp-1" title={label}>
          {label}
        </p>
        <ArrowUpRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <p className="tabular text-2xl font-semibold tracking-tight">{value}</p>
        {children && <div className="mt-auto text-xs text-muted-foreground">{children}</div>}
      </div>
    </Link>
  );
}

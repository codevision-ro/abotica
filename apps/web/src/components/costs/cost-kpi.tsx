import type { LucideIcon } from "lucide-react";
import { sectionCardClass, SectionIcon } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/** One headline number of the cost report: tinted icon and label, the value, an optional muted hint. */
export function CostKpi({ icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint?: string }) {
  return (
    <div className={cn(sectionCardClass, "flex min-w-0 flex-col gap-3 p-4 sm:p-5")}>
      <div className="flex items-center gap-2.5">
        <SectionIcon icon={icon} className="size-7 rounded-md" />
        <p className="line-clamp-2 min-w-0 text-sm leading-snug text-muted-foreground" title={label}>
          {label}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

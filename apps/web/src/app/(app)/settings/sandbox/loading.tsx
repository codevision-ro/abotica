import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Settings > Sandbox while it loads: title, the status card, then the form sections. */
export default function Loading() {
  return (
    <>
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {["h-28", "h-36", "h-72", "h-12"].map((height, i) => (
        <div key={i} className={sectionCardClass}>
          <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
          </div>
          <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
          <div className="p-4 sm:p-5">
            <Skeleton className={cn(height, "rounded-xl")} />
          </div>
        </div>
      ))}
    </>
  );
}

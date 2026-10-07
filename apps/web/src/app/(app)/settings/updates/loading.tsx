import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Settings > Updates while it loads: title and check button, the version card, then the automatic checks row. */
export default function Loading() {
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className={sectionCardClass}>
        <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-[4.75rem] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-3.5 w-40" />
        </div>
      </div>
      <div className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <Skeleton className="h-[18px] w-8 rounded-full" />
      </div>
    </>
  );
}

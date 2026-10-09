import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Settings (the general page) while it loads: its title, then the language and time zone rows. */
export default function Loading() {
  return (
    <>
      <div className="space-y-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className={cn(sectionCardClass, "flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5")}>
          <Skeleton className="size-8 rounded-lg" />
          <div className="min-w-0 flex-1 basis-56 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-8 w-full sm:w-60" />
        </div>
      ))}
    </>
  );
}

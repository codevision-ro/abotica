import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageBody>
      <Skeleton className="h-7 w-24" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-3.5 w-40" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="size-8" />
        </div>
      </div>
      <div className="flex gap-4 overflow-hidden border-b border-border/70 pb-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-20 shrink-0" />
        ))}
      </div>
      <div className="flex flex-col gap-5">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className={sectionCardClass}>
            <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-64 max-w-full" />
              </div>
            </div>
            <div className="border-t border-border/60 p-4 sm:p-5">
              <Skeleton className={i === 0 ? "h-48 rounded-xl" : "h-20 rounded-xl"} />
            </div>
          </div>
        ))}
      </div>
    </PageBody>
  );
}

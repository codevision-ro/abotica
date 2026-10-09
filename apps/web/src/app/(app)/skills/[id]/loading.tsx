import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Loading() {
  return (
    <PageBody>
      <Skeleton className="h-7 w-24" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex gap-4 overflow-hidden border-b border-border/70 pb-3">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-24 shrink-0" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="mb-2 flex items-center gap-4">
            <Skeleton className="size-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-6 w-56 max-w-full" />
              <Skeleton className="h-4 w-80 max-w-full" />
            </div>
          </div>
          {["h-[60vh] min-h-80", "h-24"].map((height, i) => (
            <div key={i} className={sectionCardClass}>
              <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3.5 w-64 max-w-full" />
                </div>
              </div>
              <div className="border-t border-border/60 p-4 sm:p-5">
                <Skeleton className={cn(height, "rounded-xl")} />
              </div>
            </div>
          ))}
        </div>
        <div className="hidden lg:block">
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </div>
    </PageBody>
  );
}

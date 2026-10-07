import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Loading() {
  return (
    <PageBody>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-20 max-sm:hidden" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center">
            <Skeleton className="h-8 w-[30rem] max-w-full" />
            <Skeleton className="h-10 rounded-xl md:flex-1" />
          </div>
          <div className={cn(sectionCardClass, "divide-y divide-border/60")}>
            <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    </PageBody>
  );
}

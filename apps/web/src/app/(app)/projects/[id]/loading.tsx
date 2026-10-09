import { PageBody } from "@/components/app/page-header";
import { sectionCardClass, SectionDivider } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function CardSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn(sectionCardClass, className)}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-36" />
      </div>
      <SectionDivider />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <PageBody>
      <Skeleton className="-mb-2 h-8 w-24" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Skeleton className="size-14 rounded-2xl" />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-48" />
        </div>
      </div>
      <div className="flex h-10 items-center gap-6 border-b border-border/70 px-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-20" />
        ))}
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className={cn(sectionCardClass, "flex flex-col gap-3 p-4 sm:p-5", i === 2 && "col-span-2 sm:col-span-1")}
              >
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-7 rounded-md" />
                  <Skeleton className="h-4 w-24" />
                </div>
                <Skeleton className="h-7 w-20" />
              </div>
            ))}
          </div>
          <CardSkeleton rows={1} />
          <CardSkeleton rows={4} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <CardSkeleton rows={1} />
          <CardSkeleton rows={2} />
        </div>
      </div>
    </PageBody>
  );
}

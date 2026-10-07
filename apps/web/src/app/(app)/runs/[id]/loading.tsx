import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function SectionSkeleton({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn(sectionCardClass, className)}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-28" />
      </div>
      {children && <div className="space-y-3 border-t border-border/60 p-4 sm:p-5">{children}</div>}
    </div>
  );
}

export default function Loading() {
  return (
    <PageBody>
      <Skeleton className="-mb-2 h-8 w-20" />
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionSkeleton />
          <SectionSkeleton>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </SectionSkeleton>
          <SectionSkeleton>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="ml-9 h-28 rounded-xl" />
            ))}
          </SectionSkeleton>
        </div>
        <div className="order-first lg:order-none">
          <SectionSkeleton>
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </SectionSkeleton>
        </div>
      </div>
    </PageBody>
  );
}

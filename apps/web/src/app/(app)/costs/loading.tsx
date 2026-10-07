import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function SectionSkeleton({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn(sectionCardClass, className)}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="border-t border-border/60 p-4 sm:p-5">{children}</div>
    </div>
  );
}

export default function Loading() {
  return (
    <PageBody>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-52 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={cn(sectionCardClass, "space-y-3 p-4 sm:p-5")}>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>
      <SectionSkeleton>
        <Skeleton className="h-64 w-full" />
      </SectionSkeleton>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <SectionSkeleton key={i}>
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, j) => (
                <Skeleton key={j} className="h-8 w-full" />
              ))}
            </div>
          </SectionSkeleton>
        ))}
      </div>
    </PageBody>
  );
}

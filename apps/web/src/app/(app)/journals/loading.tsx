import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Loading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <Skeleton className="h-10 rounded-xl md:flex-1" />
        <Skeleton className="h-10 rounded-xl sm:w-48" />
        <Skeleton className="h-10 rounded-xl sm:w-80" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className={cn(sectionCardClass, "divide-y divide-border/60")}>
          <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-44" />
            </div>
          </div>
          <div className="space-y-2 px-4 py-3.5 sm:px-5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </PageBody>
  );
}

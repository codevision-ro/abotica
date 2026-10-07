import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className={sectionCardClass}>
        <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:flex sm:px-5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 sm:h-7 sm:w-32" />
          ))}
        </div>
        <div className="h-9 border-y border-border/60 bg-muted/30 max-md:hidden" />
        <div className="divide-y divide-border/60">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-5 w-20 rounded-full md:ml-10" />
              <Skeleton className="ml-auto h-4 w-16 max-md:hidden" />
            </div>
          ))}
        </div>
      </div>
    </PageBody>
  );
}

import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Loading() {
  return (
    <PageBody className="max-w-4xl">
      <Skeleton className="h-7 w-44" />
      <div className="flex items-center gap-4">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-8 w-80 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className={cn(sectionCardClass, "divide-y divide-border/60")}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2.5 px-4 py-4 sm:px-5">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="ml-auto h-3 w-24" />
            </div>
            <div className="space-y-2 sm:pl-9.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </PageBody>
  );
}

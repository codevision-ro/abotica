import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function CardSkeleton({ lines, className }: { lines: number; className?: string }) {
  return (
    <div className={cn(sectionCardClass, "flex flex-col gap-4 p-4 sm:p-5", className)}>
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-28" />
      </div>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full last:w-2/3" />
      ))}
    </div>
  );
}

export default function Loading() {
  return (
    <PageBody className="max-w-6xl gap-4">
      <Skeleton className="h-8 w-24" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28 rounded-lg" />
        </div>
      </div>
      <div className="@container">
        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={1} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={5} />
          </div>
          <div className="flex flex-col gap-4 max-@3xl:order-first">
            <CardSkeleton lines={6} />
            <CardSkeleton lines={2} />
          </div>
        </div>
      </div>
    </PageBody>
  );
}

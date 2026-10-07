import { PageBody } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";

function SectionHeadingSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-8 rounded-lg" />
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </div>
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-12 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center justify-between border-t pt-3">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-7 w-14" />
      </div>
    </div>
  );
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** Mirrors the MCP list: the built-in servers, then the user's. */
export default function Loading() {
  return (
    <PageBody>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-4">
        <SectionHeadingSkeleton />
        <div className={GRID}>
          {Array.from({ length: 4 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 pt-2">
        <SectionHeadingSkeleton />
        <div className={GRID}>
          {Array.from({ length: 2 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </PageBody>
  );
}

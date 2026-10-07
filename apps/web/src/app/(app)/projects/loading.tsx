import { PageBody } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="flex min-h-10 items-center justify-between gap-4 border-t pt-3">
        <div className="flex -space-x-1.5">
          <Skeleton className="size-7 rounded-lg ring-2 ring-card" />
          <Skeleton className="size-7 rounded-lg ring-2 ring-card" />
        </div>
        <Skeleton className="h-3.5 w-28" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <PageBody>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80 max-w-[70vw]" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex h-10 items-center gap-1 border-b border-border/70">
        {["w-12", "w-8", "w-16"].map((w) => (
          <Skeleton key={w} className={`mx-3 h-4 ${w}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </PageBody>
  );
}

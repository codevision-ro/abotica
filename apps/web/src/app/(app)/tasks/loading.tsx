import { Skeleton } from "@/components/ui/skeleton";

const CARDS = [3, 2, 1, 1, 2];

export default function Loading() {
  return (
    <div className="flex h-[calc(100svh-3.5rem-1rem)] min-h-0 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-full rounded-full sm:w-60" />
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-32 rounded-full" />
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="ml-auto h-8 w-40 rounded-full" />
      </div>
      <div className="-mx-4 flex min-h-0 flex-1 gap-3 overflow-hidden px-4 md:mx-0 md:px-0">
        {CARDS.map((count, i) => (
          <div
            key={i}
            className="flex w-[85vw] max-w-80 shrink-0 flex-col gap-2 rounded-2xl border border-border/50 bg-muted/35 p-2 md:w-auto md:max-w-none md:min-w-52 md:flex-1 dark:bg-muted/20"
          >
            <div className="flex items-center gap-2 px-1.5 py-1">
              <Skeleton className="size-4 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
            {Array.from({ length: count }, (_, j) => (
              <Skeleton key={j} className="h-28 w-full rounded-xl" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

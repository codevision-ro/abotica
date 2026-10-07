import { PageBody } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the header, the tab strip, the search field and the card grid of the skills list. */
export default function Loading() {
  return (
    <PageBody>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <div className="flex gap-1 border-b border-border/70">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex h-10 items-center px-3">
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-full max-w-sm" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex flex-col gap-4 rounded-xl border bg-card p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-12 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3.5 w-24" />
                </div>
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
              <div className="border-t pt-3">
                <Skeleton className="h-3.5 w-36" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageBody>
  );
}

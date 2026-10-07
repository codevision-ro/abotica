import { PageBody } from "@/components/app/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the tabs, the "New" button and the card grid of the automations page. */
export default function Loading() {
  return (
    <PageBody>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-52 rounded-lg" />
          <Skeleton className="h-8 w-36" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex flex-col gap-4 rounded-xl border bg-card p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-12 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3.5 w-24" />
                </div>
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-7 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageBody>
  );
}

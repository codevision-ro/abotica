import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A section card with icon, title, description and a few rows, like SectionCard on the dashboard. */
function CardSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={cn(sectionCardClass, "min-w-0", className)}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
      <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <div className="space-y-3 p-4 sm:p-5">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/** Mirrors the dashboard (the index route); also shown for nested routes without a loading.tsx of their own. */
export default function Loading() {
  return (
    <PageBody>
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-64 max-w-full rounded-lg" />
        <Skeleton className="h-4 w-44" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={cn(sectionCardClass, "flex flex-col gap-3 p-3.5 sm:p-5")}>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CardSkeleton rows={2} />
        <CardSkeleton rows={2} />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <CardSkeleton rows={5} className="lg:col-span-3" />
        <div className={cn(sectionCardClass, "min-w-0 lg:col-span-2")}>
          <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
          <div className="p-4 sm:p-5">
            <Skeleton className="h-56 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </PageBody>
  );
}

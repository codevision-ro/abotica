import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Content of a settings page while it loads: its title, then section cards. The nav stays from the layout. */
export default function Loading() {
  return (
    <>
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {[3, 2].map((rows, i) => (
        <div key={i} className={sectionCardClass}>
          <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
          </div>
          <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            {Array.from({ length: rows }, (_, j) => (
              <div key={j} className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className={cn("h-3.5 max-w-full", j % 2 ? "w-64" : "w-80")} />
                </div>
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

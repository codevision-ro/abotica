import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SectionHeadSkeleton } from "./settings-skeleton";

/**
 * A settings page while it loads: its title, then one section card per entry of `sections`, each with that
 * many setting rows (0: a single block, as for a list or a status). The nav stays from the layout.
 */
export function SettingsPageSkeleton({ sections }: { sections: number[] }) {
  return (
    <>
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {sections.map((rows, i) => (
        <div key={i} className={sectionCardClass}>
          <SectionHeadSkeleton />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            {rows === 0 ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : (
              Array.from({ length: rows }, (_, j) => (
                <div key={j} className="flex items-center justify-between gap-4">
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className={cn("h-3.5 max-w-full", j % 2 ? "w-64" : "w-80")} />
                  </div>
                  <Skeleton className="h-8 w-28" />
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </>
  );
}

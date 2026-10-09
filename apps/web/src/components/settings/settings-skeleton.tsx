import { sectionCardClass, SectionDivider } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A settings page's title and description while it loads; `action` adds the button on the right. */
export function SettingsHeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {action && <Skeleton className="h-8 w-36" />}
    </div>
  );
}

/** A FormSection's icon, title and description while it loads, with the line under them. */
export function SectionHeadSkeleton() {
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <Skeleton className="size-8 rounded-lg" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
      </div>
      <SectionDivider />
    </>
  );
}

/**
 * A FormSection while it loads: icon, title and description, then `rows` setting rows (label and hint
 * left, control right), or a block of `height` for content that is not rows.
 */
export function SettingsSectionSkeleton({ rows = 2, height }: { rows?: number; height?: string }) {
  return (
    <div className={sectionCardClass}>
      <SectionHeadSkeleton />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {height ? (
          <Skeleton className={cn(height, "rounded-xl")} />
        ) : (
          Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-44" />
                <Skeleton className={cn("h-3.5 max-w-full", i % 2 ? "w-64" : "w-80")} />
              </div>
              <Skeleton className="h-8 w-full sm:w-32" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A closed FormSectionCollapsible ("Advanced") while it loads. */
export function SettingsCollapsedSkeleton() {
  return (
    <div className={cn(sectionCardClass, "flex items-center gap-3 px-4 py-3.5 sm:px-5")}>
      <Skeleton className="size-8 rounded-lg" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
      </div>
      <Skeleton className="size-4" />
    </div>
  );
}

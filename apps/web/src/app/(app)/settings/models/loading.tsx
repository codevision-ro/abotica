import { sectionCardClass } from "@/components/app/section-card";
import {
  SettingsCollapsedSkeleton,
  SettingsHeaderSkeleton,
  SettingsSectionSkeleton,
} from "@/components/settings/settings-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Settings > Models while it loads: title and "Add provider", provider cards, the defaults, then the rest. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton action />
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className={sectionCardClass}>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Skeleton className="size-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3.5 w-44" />
              </div>
            </div>
            <div className="p-4 pt-0">
              <Skeleton className="h-16 rounded-xl" />
            </div>
          </div>
        ))}
      </div>
      <SettingsSectionSkeleton height="h-80" />
      <SettingsSectionSkeleton height="h-40" />
      <SettingsCollapsedSkeleton />
    </>
  );
}

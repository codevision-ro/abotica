import { sectionCardClass } from "@/components/app/section-card";
import {
  SettingsCollapsedSkeleton,
  SettingsHeaderSkeleton,
  SettingsSectionSkeleton,
} from "@/components/settings/settings-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Settings > System while it loads: the version card and automatic checks, the sandbox, preview links, work at once. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton />
      <div className={sectionCardClass}>
        <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-[4.75rem] rounded-xl" />
            ))}
          </div>
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-7 w-28" />
          </div>
        </div>
      </div>
      <SettingsSectionSkeleton rows={1} />
      <SettingsSectionSkeleton height="h-40" />
      <SettingsCollapsedSkeleton />
      <SettingsSectionSkeleton rows={2} />
      <SettingsSectionSkeleton rows={3} />
    </>
  );
}

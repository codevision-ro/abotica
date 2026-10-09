import { SettingsHeaderSkeleton, SettingsSectionSkeleton } from "@/components/settings/settings-skeleton";

/** Settings > Budget while it loads: title, the monthly budget, then the alerts. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton />
      <SettingsSectionSkeleton rows={1} />
      <SettingsSectionSkeleton height="h-16" />
    </>
  );
}

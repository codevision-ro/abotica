import {
  SettingsCollapsedSkeleton,
  SettingsHeaderSkeleton,
  SettingsSectionSkeleton,
} from "@/components/settings/settings-skeleton";

/** Settings > Agents while it loads: title, the instructions, delegation and limits, then Advanced. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton />
      <SettingsSectionSkeleton height="h-44" />
      <SettingsSectionSkeleton rows={1} />
      <SettingsSectionSkeleton rows={3} />
      <SettingsCollapsedSkeleton />
    </>
  );
}

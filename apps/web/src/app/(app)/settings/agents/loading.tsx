import {
  SettingsCollapsedSkeleton,
  SettingsHeaderSkeleton,
  SettingsSectionSkeleton,
} from "@/components/settings/settings-skeleton";

/** Settings > Agents while it loads: the instructions and Advanced, then Memory with embeddings and Advanced. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton />
      <SettingsSectionSkeleton height="h-44" />
      <SettingsCollapsedSkeleton />
      <SettingsHeaderSkeleton />
      <SettingsSectionSkeleton height="h-40" />
      <SettingsCollapsedSkeleton />
    </>
  );
}

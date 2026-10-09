import {
  SettingsCollapsedSkeleton,
  SettingsHeaderSkeleton,
  SettingsSectionSkeleton,
} from "@/components/settings/settings-skeleton";

/** Settings > Memory while it loads: title, the embeddings card, context and approval, then Advanced. */
export default function Loading() {
  return (
    <>
      <SettingsHeaderSkeleton />
      <SettingsSectionSkeleton height="h-40" />
      <SettingsSectionSkeleton rows={3} />
      <SettingsSectionSkeleton rows={1} />
      <SettingsCollapsedSkeleton />
    </>
  );
}

import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Reports while it loads: the daily and the weekly report. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[2, 3]} />;
}

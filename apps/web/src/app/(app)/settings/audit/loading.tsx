import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Audit log while it loads: the filtered table. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[0]} />;
}

import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Keys while it loads: the list of keys. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[0]} />;
}

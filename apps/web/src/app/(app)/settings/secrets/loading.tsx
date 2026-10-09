import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Secrets while it loads: the list of secrets. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[0]} />;
}

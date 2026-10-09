import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Sandbox while it loads: status, on or off, default policy, limits, containers, advanced. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[0, 0, 0, 1, 2]} />;
}

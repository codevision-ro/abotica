import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Telegram while it loads: bot, access, then the reports. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[1, 2, 2, 2]} />;
}

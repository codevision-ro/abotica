import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Telegram while it loads: bot, access, commands, topics. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[1, 2, 0, 0]} />;
}

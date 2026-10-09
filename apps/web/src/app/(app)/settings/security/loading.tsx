import { SettingsPageSkeleton } from "@/components/settings/settings-page-skeleton";

/** Settings > Security while it loads: 2FA, password, sessions, session length. */
export default function Loading() {
  return <SettingsPageSkeleton sections={[1, 2, 0, 1]} />;
}

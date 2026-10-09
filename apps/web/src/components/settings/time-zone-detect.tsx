"use client";

import { isTimeZone } from "@abotica/core/settings";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { saveSettings } from "@/server/actions/app-settings";

/**
 * Saves the browser's time zone once, while none was ever saved (a new install), so schedules, digests
 * and dates follow the user's clock from the start instead of UTC. Mounted by the app layout only then.
 */
export function TimeZoneDetect() {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timezone || !isTimeZone(timezone)) return;
    void saveSettings({ domain: "general", patch: { timezone } }).then((res) => {
      if (res.ok) router.refresh();
    });
  }, [router]);

  return null;
}

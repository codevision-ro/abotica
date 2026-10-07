"use server";

import { audit, checkForUpdates, getSettings, updateSettings } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/** Settings > Updates "Check now": asks GitHub even when automatic checks are off. */
export const checkUpdatesNow = action(z.object({}), async () => {
  const status = await checkForUpdates({ force: true });
  await audit({
    actor: "user",
    action: "updates.checked",
    entityType: "system",
    data: { current: status.current, latest: status.latest?.version ?? null, error: status.error },
  });
  revalidatePath("/", "layout");
  return status;
});

export const setUpdateChecks = action(z.object({ enabled: z.boolean() }), async ({ enabled }) => {
  const before = await getSettings();
  await updateSettings({ updateChecks: enabled });
  if (before.updateChecks !== enabled) {
    await audit({
      actor: "user",
      action: "settings.updated",
      entityType: "settings",
      entityId: "app",
      data: { updateChecks: { from: before.updateChecks, to: enabled } },
    });
  }
  revalidatePath("/settings/updates");
});

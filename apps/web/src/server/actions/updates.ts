"use server";

import { audit, checkForUpdates } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/** Settings > System "Check now": asks GitHub even when automatic checks are off. */
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

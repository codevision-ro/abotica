"use server";

import { audit, setKillSwitch as writeKillSwitch } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

export const setKillSwitch = action(z.object({ active: z.boolean() }), async ({ active }) => {
  await writeKillSwitch(active);
  await audit({ actor: "user", action: active ? "kill-switch.enabled" : "kill-switch.disabled", entityType: "system" });
  revalidatePath("/", "layout");
  return active;
});

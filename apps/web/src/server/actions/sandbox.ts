"use server";

import { audit, getSettings, parseSandboxSettings, requestSandboxCheck, updateSettings } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/** Saves Settings > Sandbox; the worker then rebuilds its backend from the new settings. */
export const updateSandboxSettings = action(z.unknown(), async (input) => {
  const sandbox = parseSandboxSettings(input);
  const before = (await getSettings()).sandbox;
  await updateSettings({ sandbox });
  if (JSON.stringify(before) !== JSON.stringify(sandbox)) {
    await audit({
      actor: "user",
      action: "settings.updated",
      entityType: "settings",
      entityId: "app",
      data: { sandbox: { from: before, to: sandbox } },
    });
  }
  await requestSandboxCheck();
  revalidatePath("/settings/sandbox");
  return sandbox;
});

/** Asks the worker to probe the sandbox again; the page refreshes when the new status is published. */
export const checkSandbox = action(z.object({}), async () => {
  await requestSandboxCheck();
});

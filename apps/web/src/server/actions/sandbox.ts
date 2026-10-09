"use server";

import { requestSandboxCheck } from "@abotica/core";
import { z } from "zod";
import { action } from "../action";

/**
 * Asks the worker to probe the sandbox again ("Check again"; a saved sandbox section of Settings > System triggers it in the
 * worker by itself); the page refreshes when the new status is published.
 */
export const checkSandbox = action(z.object({}), async () => {
  await requestSandboxCheck();
});

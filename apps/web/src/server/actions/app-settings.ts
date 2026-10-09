"use server";

import { SETTINGS_DOMAINS, type SettingsDomain, updateSettings } from "@abotica/core";
import { UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/**
 * Fields with their own action, because saving them does more than store a value: the default models
 * check the providers, the Ollama address refreshes the catalog, the embedding provider embeds everything
 * again and Telegram checks the bot token (see actions/settings.ts).
 */
const OWN_ACTION: Partial<Record<SettingsDomain, readonly string[]>> = {
  models: ["chains", "reasoningEffort", "ollama"],
  memory: ["embeddingProvider"],
  telegram: ["allowedUserIds", "notifyChatId"],
};

/**
 * Saves a settings form: the changed fields of one domain, validated in core with the same schema the
 * form uses (settings-schema.ts). Settings reach every page (time zone, language, limits), so the whole
 * app is revalidated. Returns the domain as stored.
 */
export const saveSettings = action(
  z.object({ domain: z.enum(SETTINGS_DOMAINS), patch: z.record(z.string(), z.unknown()) }),
  async ({ domain, patch }) => {
    if (OWN_ACTION[domain]?.some((field) => field in patch)) throw new UserError("settings.errors.ownAction");
    const next = await updateSettings(domain, patch as never);
    revalidatePath("/", "layout");
    return next;
  },
);

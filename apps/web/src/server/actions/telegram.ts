"use server";

import {
  fetchTelegramBot,
  isTelegramChatId,
  removeTelegramToken,
  saveTelegramAccess,
  saveTelegramToken,
  SETTINGS_LIMITS,
} from "@abotica/core";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";

/**
 * Settings > Telegram, saved as one form. A new token is checked with Telegram first, so a wrong one is
 * refused here instead of failing in the worker; an empty one keeps the stored token. Who may talk to the
 * bot and the notification chat are the `telegram` settings, written by core.
 */
export const updateTelegramSettings = action(
  z.object({
    token: z.string().trim().default(""),
    allowedUserIds: z
      .array(z.number().int().positive("settings.validation.telegram.userIds"))
      .max(SETTINGS_LIMITS.telegram.allowedUsers.max, "settings.validation.telegram.userIds"),
    notifyChatId: z.string().trim().refine(isTelegramChatId, "settings.validation.telegram.chatId").nullable(),
  }),
  async ({ token, allowedUserIds, notifyChatId }) => {
    const bot = token ? await fetchTelegramBot(token) : null;
    if (token) {
      const t = await getTranslations("settings.telegram");
      await saveTelegramToken(token, t("secretDescription"));
    }
    await saveTelegramAccess({ allowedUserIds, notifyChatId });
    revalidatePath("/settings/telegram");
    revalidatePath("/");
    return { username: bot?.username ?? null };
  },
);

export const deleteTelegramToken = action(z.object({}), async () => {
  await removeTelegramToken();
  revalidatePath("/settings/telegram");
  revalidatePath("/");
});

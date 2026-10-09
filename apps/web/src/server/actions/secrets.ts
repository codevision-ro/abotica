"use server";

import { announceTelegramChange, audit, TELEGRAM_TOKEN_SECRET, upsertSecret } from "@abotica/core";
import { db, secrets } from "@abotica/db";
import { eq } from "@abotica/db/orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/** Pages that show a secret by name: provider keys on Models, the bot token on Telegram. */
function revalidateSecretPages() {
  revalidatePath("/settings/keys");
  revalidatePath("/settings/models");
  revalidatePath("/settings/telegram");
}

export const setVaultSecret = action(
  z.object({
    name: z
      .string()
      .trim()
      .min(1, "settings.validation.nameRequired")
      .max(64)
      .regex(/^[A-Z0-9_]+$/, "settings.validation.nameFormat"),
    value: z.string().min(1, "settings.validation.valueRequired"),
    description: z.string().trim().max(300).default(""),
    projectId: z.uuid().nullable().default(null),
  }),
  async ({ name, value, description, projectId }) => {
    // The secrets page shows every secret with its owner, so it is the one place a secret may change owner.
    await upsertSecret({ name, value, description, projectId }, { allowMove: true });
    if (name === TELEGRAM_TOKEN_SECRET) await announceTelegramChange();
    revalidateSecretPages();
    return null;
  },
);

export const deleteVaultSecret = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const [row] = await db.delete(secrets).where(eq(secrets.id, id)).returning({ name: secrets.name });
  if (row) await audit({ actor: "user", action: "secret.deleted", entityType: "secret", entityId: row.name });
  if (row?.name === TELEGRAM_TOKEN_SECRET) await announceTelegramChange();
  revalidateSecretPages();
  return null;
});

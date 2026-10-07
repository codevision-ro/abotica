"use server";

import { extendPreview as extend, revokePreview as revoke, setPreviewPublic as setPublic } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

const id = z.object({ id: z.string().uuid() });

/** The previews page and the project tabs that list them. */
function revalidate() {
  revalidatePath("/previews");
  revalidatePath("/projects", "layout");
}

export const setPreviewPublic = action(id.extend({ public: z.boolean() }), async (input) => {
  await setPublic(input.id, input.public);
  revalidate();
});

export const extendPreview = action(id, async (input) => {
  await extend(input.id);
  revalidate();
});

export const revokePreview = action(id, async (input) => {
  await revoke(input.id);
  revalidate();
});

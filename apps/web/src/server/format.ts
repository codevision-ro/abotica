import "server-only";
import { getLocale } from "next-intl/server";
import { createFormat } from "@/lib/format";

/** Date, number and cost formatting in the current language (server components). */
export async function getFormat() {
  return createFormat(await getLocale());
}

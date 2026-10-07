"use client";

import { useLocale } from "next-intl";
import { useMemo } from "react";
import { createFormat } from "@/lib/format";

/** Date, number and cost formatting in the current language (client components). */
export function useFormat() {
  const locale = useLocale();
  return useMemo(() => createFormat(locale), [locale]);
}

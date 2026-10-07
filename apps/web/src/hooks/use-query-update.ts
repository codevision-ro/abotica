"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

export type QueryParams = Record<string, string | undefined>;

/** Rewrites the URL query from the server-provided current params, so callers need no useSearchParams. */
export function useQueryUpdate(current: QueryParams) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const update = (patch: Record<string, string | null | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...current, ...patch })) if (value) next.set(key, value);
    const qs = next.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  };
  return { update, pending };
}

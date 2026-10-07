"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

const FAILURES = ["denied", "expired", "failed"] as const;

/**
 * Handles the `?oauth=...&message=...` the OAuth callback redirects back with: a toast for the
 * outcome, `onConnected` on success, then the params are removed without a history entry.
 */
export function useMcpOAuthReturn({ list, onConnected }: { list?: boolean; onConnected?: () => void } = {}) {
  const t = useTranslations("mcp.oauth.returned");
  const router = useRouter();
  const pathname = usePathname();
  const handled = useRef(false);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("oauth");
    if (!outcome) return;
    const message = params.get("message") ?? undefined;
    if (outcome === "connected") {
      toast.success(t("connected"));
      onConnectedRef.current?.();
    } else if ((FAILURES as readonly string[]).includes(outcome)) {
      const key = list && outcome === "expired" ? "expiredList" : (outcome as (typeof FAILURES)[number]);
      toast.error(t(key), { description: message });
    }
    params.delete("oauth");
    params.delete("message");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [list, pathname, router, t]);
}

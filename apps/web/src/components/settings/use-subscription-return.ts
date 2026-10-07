"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { SUBSCRIPTION_RETURN_PARAMS as PARAMS } from "@/lib/subscription-return";

/**
 * Handles the `?subscription=...` the plan sign-in callback redirects back with: a toast for the
 * outcome, then the params are removed without a history entry. `planLabels` names each provider's plan.
 */
export function useSubscriptionReturn(planLabels: Record<string, string>) {
  const t = useTranslations("settings.providers.plan.returned");
  const router = useRouter();
  const pathname = usePathname();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get(PARAMS.outcome);
    if (!outcome) return;
    const id = params.get(PARAMS.provider);
    const name = { plan: (id && planLabels[id]) || id || "" };
    const message = params.get(PARAMS.message) ?? undefined;
    if (outcome === "connected") toast.success(t("connected", name), { description: t("connectedDescription", name) });
    else if (outcome === "not-granted") toast.error(t("notGranted"), { description: t("notGrantedDescription") });
    else if (outcome === "denied" || outcome === "expired") toast.error(t(outcome));
    else toast.error(t("failed"), { description: message });
    for (const key of Object.values(PARAMS)) params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [planLabels, pathname, router, t]);
}

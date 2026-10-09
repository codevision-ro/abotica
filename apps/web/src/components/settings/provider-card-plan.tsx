"use client";

import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/app/relative-time";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { completeSubscription, startSubscription } from "@/server/actions/settings";
import type { ProviderStatus } from "@/server/queries/settings";
import { ProviderNotice } from "./provider-notice";

/**
 * Connects a provider through the user's plan (OpenAI through ChatGPT). When the app is not opened
 * over loopback the plan's callback cannot reach it, so the user pastes the address it landed on.
 */
export function ProviderCardPlan({
  provider,
}: {
  provider: ProviderStatus & { plan: NonNullable<ProviderStatus["plan"]> };
}) {
  const t = useTranslations("settings.providers.plan");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [starting, startSignIn] = useTransition();
  const [completing, startComplete] = useTransition();
  /** The sign-in address while waiting for the pasted callback; null when no sign-in is open. */
  const [awaiting, setAwaiting] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const { plan } = provider;
  const names = { plan: plan.label, provider: provider.label };

  function signIn() {
    startSignIn(async () => {
      const res = await startSubscription({ provider: provider.id });
      if (!res.ok) return void toast.error(res.error);
      if (res.data.direct) return window.location.assign(res.data.url);
      window.open(res.data.url, "_blank", "noopener");
      setAwaiting(res.data.url);
    });
  }

  function complete(e: React.FormEvent) {
    e.preventDefault();
    startComplete(async () => {
      const res = await completeSubscription({ provider: provider.id, callbackUrl });
      if (!res.ok) return void toast.error(res.error);
      setAwaiting(null);
      setCallbackUrl("");
      toast.success(t("returned.connected", names), { description: t("returned.connectedDescription", names) });
      router.refresh();
    });
  }

  if (plan.connected) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 flex-col text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t.rich("account", {
              account: plan.account?.email ?? plan.account?.name ?? plan.label,
              strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </span>
          {plan.connectedAt && (
            <>
              <span aria-hidden className="max-sm:hidden">
                ·
              </span>
              <span>{t.rich("connectedAt", { time: () => <RelativeTime date={plan.connectedAt!} /> })}</span>
            </>
          )}
        </p>
        <Button variant="ghost" size="sm" className="-mr-2" asChild>
          <a href={plan.usageUrl} target="_blank" rel="noopener noreferrer">
            {t("manageUsage")} <ArrowUpRight data-icon="inline-end" />
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-pretty text-muted-foreground">{t("description", names)}</p>
      {plan.problem && (
        <ProviderNotice tone="warning">
          {plan.problem.kind === "plan-not-granted"
            ? t("planNotGranted")
            : t("signInAgain", { ...names, error: plan.problem.detail })}
        </ProviderNotice>
      )}
      {provider.connection === "api-key" && <ProviderNotice>{t("planReplacesKey")}</ProviderNotice>}
      {awaiting ? (
        <form onSubmit={complete}>
          <Field>
            <FieldLabel htmlFor={`callback-${provider.id}`}>{t("pasteLabel")}</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`callback-${provider.id}`}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://127.0.0.1:1455/auth/callback?code=..."
              />
              <Button type="submit" disabled={completing || !callbackUrl.trim()}>
                {completing && <Spinner />} {t("pasteSubmit")}
              </Button>
            </div>
            <FieldDescription>{t("pasteHint")}</FieldDescription>
          </Field>
          <div className="mt-2 flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a href={awaiting} target="_blank" rel="noopener noreferrer">
                {t("pasteReopen")} <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAwaiting(null)}>
              {tc("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" className="self-start" onClick={signIn} disabled={starting}>
          {starting && <Spinner />} {t("connect", names)}
        </Button>
      )}
    </div>
  );
}

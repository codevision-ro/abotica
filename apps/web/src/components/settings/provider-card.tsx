"use client";

import { KeyRound, LogOut, PowerOff, Sparkles, Trash2, X, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-dialog";
import { OptionCards } from "@/components/app/option-cards";
import { RelativeTime } from "@/components/app/relative-time";
import { sectionCardClass } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { deleteProviderKey, disconnectSubscriptionAccount, setOllamaEnabled } from "@/server/actions/settings";
import type { ProviderStatus } from "@/server/queries/settings";
import { ProviderCardKey } from "./provider-card-key";
import { ProviderCardPlan } from "./provider-card-plan";
import { ProviderIcon } from "./provider-icon";
import { ProviderTestResult, useProviderTest } from "./provider-test";

type Method = "api-key" | "plan";

/**
 * One provider and how it is connected. A provider with a plan (OpenAI through ChatGPT) is reached
 * either with an API key or through the plan, never both: the user picks one and connects it.
 * A provider with nothing connected is shown only right after "Add provider"; `onClose` drops it
 * from that list (cancel, key deleted, plan disconnected, Ollama deactivated).
 */
export function ProviderCard({
  provider,
  ollamaBaseUrl,
  onClose,
}: {
  provider: ProviderStatus;
  ollamaBaseUrl?: string;
  onClose: () => void;
}) {
  const t = useTranslations("settings.providers");
  const tp = useTranslations("settings.providers.plan");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [removing, startRemove] = useTransition();
  const test = useProviderTest(provider.id);
  const [method, setMethod] = useState<Method>(provider.connection === "plan" ? "plan" : "api-key");
  const isOllama = provider.id === "ollama";
  const connected = provider.connection !== null;
  const plan = provider.plan;
  const planNames = plan ? { plan: plan.label, provider: provider.label } : undefined;

  /** Runs a removal, then closes the card: nothing is connected anymore. */
  function removeWith(run: () => Promise<{ ok: boolean; error?: string }>, done: () => void) {
    startRemove(async () => {
      const res = await run();
      if (!res.ok) return void toast.error(res.error);
      test.reset();
      onClose();
      done();
      router.refresh();
    });
  }

  const removeKey = () =>
    removeWith(
      () => deleteProviderKey({ provider: provider.id }),
      () => toast.success(t("keyRemoved", { provider: provider.label })),
    );

  const disconnectPlan = () =>
    startRemove(async () => {
      const res = await disconnectSubscriptionAccount({ provider: provider.id });
      if (!res.ok) return void toast.error(res.error);
      test.reset();
      onClose();
      if (res.data.revoked) toast.success(tp("disconnected", planNames));
      else toast.warning(tp("disconnectedUnconfirmed", planNames));
      router.refresh();
    });

  const deactivate = () =>
    removeWith(
      () => setOllamaEnabled({ enabled: false }),
      () => toast.success(t("deactivated", { provider: provider.label })),
    );

  const subtitle = isOllama ? (
    <span className="truncate font-mono" title={ollamaBaseUrl}>
      {ollamaBaseUrl}
    </span>
  ) : provider.connection === "plan" && plan ? (
    <span className="truncate">
      {t("subtitlePlan", { plan: plan.label, account: plan.account?.email ?? plan.account?.name ?? "" })}
    </span>
  ) : provider.connection === "api-key" && provider.keyUpdatedAt ? (
    <span className="truncate">
      {t.rich("subtitleKey", { time: () => <RelativeTime date={provider.keyUpdatedAt!} /> })}
    </span>
  ) : (
    <span>{t("subtitleNone")}</span>
  );

  const removal =
    provider.connection === "plan" ? (
      <ConfirmButton
        className="shrink-0 text-muted-foreground hover:text-destructive ml-auto"
        titleClassName="[overflow-wrap:anywhere]"
        destructive
        icon={LogOut}
        label={tp("disconnect")}
        title={tp("disconnectTitle", planNames)}
        description={tp("disconnectDescription", planNames)}
        confirm={tp("disconnect")}
        pending={removing}
        onConfirm={disconnectPlan}
      />
    ) : provider.connection === "local" ? (
      <ConfirmButton
        className="shrink-0 text-muted-foreground hover:text-destructive ml-auto"
        titleClassName="[overflow-wrap:anywhere]"
        destructive
        icon={PowerOff}
        label={t("deactivate")}
        title={t("deactivateTitle", { provider: provider.label })}
        description={t("deactivateDescription")}
        confirm={t("deactivate")}
        pending={removing}
        onConfirm={deactivate}
      />
    ) : (
      <ConfirmButton
        className="shrink-0 text-muted-foreground hover:text-destructive ml-auto"
        titleClassName="[overflow-wrap:anywhere]"
        destructive
        icon={Trash2}
        label={t("removeKey")}
        title={t("removeTitle", { provider: provider.label })}
        description={t("removeDescription")}
        confirm={tc("delete")}
        pending={removing}
        onConfirm={removeKey}
      />
    );

  return (
    <section
      aria-labelledby={`provider-${provider.id}-title`}
      className={cn(sectionCardClass, "flex min-w-0 flex-col", !connected && "border-primary/30")}
    >
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <ProviderIcon provider={provider.id} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 id={`provider-${provider.id}-title`} className="truncate leading-snug font-semibold tracking-tight">
            {provider.label}
          </h3>
          <p className="flex min-w-0 items-center text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {isOllama ? (
          <Badge variant={provider.models.length ? "secondary" : "outline"} className="tabular font-normal">
            {provider.models.length ? t("modelCount", { count: provider.models.length }) : t("noModels")}
          </Badge>
        ) : connected ? (
          <Badge className="bg-success/10 font-normal text-success">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {t("configured")}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {t("missing")}
          </Badge>
        )}
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />

      <div className="flex flex-1 flex-col gap-4 p-4 sm:px-5">
        {isOllama ? (
          provider.models.length ? (
            <div className="flex flex-wrap gap-1">
              {provider.models.map((m) => (
                <Badge key={m} variant="outline" className="max-w-full font-mono font-normal" title={m}>
                  <span className="truncate">{m}</span>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("ollamaEmpty")}</p>
          )
        ) : (
          <>
            {plan && (
              <OptionCards<Method>
                name={`connection-${provider.id}`}
                label={t("connectionLabel")}
                value={method}
                onValueChange={(next) => {
                  setMethod(next);
                  test.reset();
                }}
                options={[
                  {
                    value: "api-key",
                    icon: KeyRound,
                    title: t("methodKey"),
                    description: t("methodKeyHint", { provider: provider.label }),
                  },
                  {
                    value: "plan",
                    icon: Sparkles,
                    title: t("methodPlan", { plan: plan.label }),
                    description: t("methodPlanHint", { plan: plan.label }),
                  },
                ]}
              />
            )}
            {plan && method === "plan" ? (
              <ProviderCardPlan provider={{ ...provider, plan }} />
            ) : (
              <ProviderCardKey provider={provider} autoFocus={!connected && !plan} />
            )}
          </>
        )}
        <ProviderTestResult result={test.result} />
      </div>

      <div className="flex min-h-12 items-center gap-2 border-t border-border/60 px-4 py-2 sm:px-5">
        {connected ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={test.run} disabled={test.testing}>
              {test.testing ? <Spinner /> : <Zap />} {tc("test")}
            </Button>
            {provider.testModel && (
              <span
                className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                title={t("testModel", { model: provider.testModel })}
              >
                {provider.testModel}
              </span>
            )}
            {removal}
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
            <X /> {tc("cancel")}
          </Button>
        )}
      </div>
    </section>
  );
}

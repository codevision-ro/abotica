"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { setProviderKey } from "@/server/actions/settings";
import type { ProviderStatus } from "@/server/queries/settings";
import { ProviderNotice } from "./provider-notice";
import { SecretInput } from "./secret-input";

/** Saves or replaces a provider's API key; saving switches a provider off its plan. */
export function ProviderCardKey({ provider, autoFocus }: { provider: ProviderStatus; autoFocus?: boolean }) {
  const t = useTranslations("settings.providers");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [key, setKey] = useState("");
  const [saving, startSave] = useTransition();
  const hasKey = provider.connection === "api-key";
  const onPlan = provider.connection === "plan";

  function save(e: React.FormEvent) {
    e.preventDefault();
    startSave(async () => {
      const res = await setProviderKey({ provider: provider.id, value: key });
      if (!res.ok) return void toast.error(res.error);
      setKey("");
      toast.success(t("keySaved", { provider: provider.label }));
      router.refresh();
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`key-${provider.id}`}>{hasKey ? t("replaceKey") : t("apiKey")}</FieldLabel>
        <div className="flex gap-2">
          <SecretInput
            id={`key-${provider.id}`}
            autoFocus={autoFocus}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "••••••••" : "sk-..."}
          />
          <Button type="submit" variant={hasKey ? "secondary" : "default"} disabled={saving || key.trim().length < 8}>
            {saving && <Spinner />} {tc("save")}
          </Button>
        </div>
        <FieldDescription>{t("storedEncrypted")}</FieldDescription>
      </Field>
      {onPlan && provider.plan && (
        <ProviderNotice>{t("keyReplacesPlan", { plan: provider.plan.label, provider: provider.label })}</ProviderNotice>
      )}
    </form>
  );
}

"use client";

import type { ProviderId } from "@abotica/core";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSubsection } from "@/components/app/form-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { refreshModelCatalog } from "@/server/actions/settings";
import { ProviderIcon } from "./provider-icon";

/** Under Settings > Models > Advanced, the model catalog: models per active provider, with a refresh from models.dev. */
export function CatalogRefresh({
  labels,
  initialCounts,
}: {
  labels: Partial<Record<ProviderId, string>>;
  initialCounts: Record<string, number>;
}) {
  const t = useTranslations("settings.providers");
  const router = useRouter();
  const [counts, setCounts] = useState(initialCounts);
  const [pending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const res = await refreshModelCatalog({});
      if (!res.ok) return void toast.error(t("refreshFailed", { error: res.error }));
      setCounts(res.data.counts);
      toast.success(t("refreshed", { count: res.data.total }));
      router.refresh();
    });
  }

  return (
    <FormSubsection
      title={t("catalogTitle")}
      description={t("catalogDescription")}
      action={
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={pending}>
          {pending ? <Spinner /> : <RefreshCw />}
          <span className="max-sm:sr-only">{t("refresh")}</span>
        </Button>
      }
    >
      <ul className="flex flex-wrap gap-2">
        {(Object.entries(labels) as [ProviderId, string][]).map(([id, label]) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 py-1 pr-2.5 pl-1 text-sm"
          >
            <ProviderIcon provider={id} size="xs" />
            {label}
            <span className="tabular text-muted-foreground">{t("modelCount", { count: counts[id] ?? 0 })}</span>
          </li>
        ))}
      </ul>
    </FormSubsection>
  );
}

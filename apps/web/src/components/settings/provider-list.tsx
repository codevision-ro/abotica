"use client";

import type { ProviderId } from "@abotica/core";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { sectionCardClass } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { setOllamaEnabled } from "@/server/actions/settings";
import type { ProviderStatus } from "@/server/queries/settings";
import { ProviderCard } from "./provider-card";
import { ProviderIcon } from "./provider-icon";
import { SectionHeader } from "./section-header";
import { useSubscriptionReturn } from "./use-subscription-return";

/** Connected providers as cards; the rest sit behind "Add provider". */
export function ProviderList({ providers, ollamaBaseUrl }: { providers: ProviderStatus[]; ollamaBaseUrl: string }) {
  const t = useTranslations("settings.providers");
  const router = useRouter();
  // Providers added in this visit that have nothing connected yet.
  const [added, setAdded] = useState<ProviderId[]>([]);
  const [activating, startActivate] = useTransition();
  const planLabels = useMemo(
    () => Object.fromEntries(providers.flatMap((p) => (p.plan ? [[p.id, p.plan.label]] : []))),
    [providers],
  );
  useSubscriptionReturn(planLabels);

  const visible = providers.filter((p) => p.connection !== null || added.includes(p.id));
  const inactive = providers.filter((p) => !visible.includes(p));

  function add(p: ProviderStatus) {
    if (p.id !== "ollama") return setAdded((a) => [...a, p.id]);
    startActivate(async () => {
      const res = await setOllamaEnabled({ enabled: true });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("activated", { provider: p.label }));
      router.refresh();
    });
  }

  const addMenu = inactive.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={visible.length ? "outline" : "default"} disabled={activating}>
          {activating ? <Spinner /> : <Plus />} {t("addProvider")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {inactive.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => add(p)}>
            <ProviderIcon provider={p.id} size="xs" />
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} actions={addMenu} />
      {visible.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {visible.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              ollamaBaseUrl={p.id === "ollama" ? ollamaBaseUrl : undefined}
              onClose={() => setAdded((a) => a.filter((id) => id !== p.id))}
            />
          ))}
        </div>
      ) : (
        <p className={cn(sectionCardClass, "px-4 py-3.5 text-sm text-muted-foreground sm:px-5")}>{t("empty")}</p>
      )}
    </>
  );
}

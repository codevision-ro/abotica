"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all";

type Option = { value: string; label: string };

export function AuditFilters({
  actors,
  entityTypes,
  actor,
  entityType,
}: {
  actors: Option[];
  entityTypes: Option[];
  actor?: string;
  entityType?: string;
}) {
  const t = useTranslations("settings.audit");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function go(next: { actor?: string; entityType?: string }) {
    const params = new URLSearchParams();
    if (next.actor) params.set("actor", next.actor);
    if (next.entityType) params.set("entity", next.entityType);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/settings/audit?${qs}` : "/settings/audit"));
  }

  return (
    <div
      className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-2 transition-opacity aria-busy:opacity-60"
      aria-busy={pending}
    >
      <Select value={actor ?? ALL} onValueChange={(v) => go({ actor: v === ALL ? undefined : v, entityType })}>
        <SelectTrigger className="min-w-0 flex-1 basis-40 sm:w-48 sm:flex-none sm:basis-auto" aria-label={t("filterActor")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allActors")}</SelectItem>
          {actors.map((a) => (
            <SelectItem key={a.value} value={a.value}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={entityType ?? ALL} onValueChange={(v) => go({ actor, entityType: v === ALL ? undefined : v })}>
        <SelectTrigger
          className="min-w-0 flex-1 basis-40 sm:w-48 sm:flex-none sm:basis-auto"
          aria-label={t("filterEntity")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("allEntities")}</SelectItem>
          {entityTypes.map((e) => (
            <SelectItem key={e.value} value={e.value}>
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(actor || entityType) && (
        <Button variant="ghost" size="sm" onClick={() => go({})}>
          <X /> {t("reset")}
        </Button>
      )}
    </div>
  );
}

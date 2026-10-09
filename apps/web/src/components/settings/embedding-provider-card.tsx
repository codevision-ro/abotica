"use client";

import type { EmbeddingProvider, EmbeddingReadiness } from "@abotica/core";
import { CircleAlert, CircleCheck, Cpu, HardDrive, Save, ScanSearch } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { setEmbeddingProvider } from "@/server/actions/settings";
import type { EmbeddingStatus } from "@/server/queries/embeddings";
import { ProviderNotice } from "./provider-notice";

/** Names of the providers; the built-in model's is translated. */
const LABELS: Record<Exclude<EmbeddingProvider, "local">, string> = { ollama: "Ollama" };

const mono = (chunks: React.ReactNode) => <span className="font-mono text-xs">{chunks}</span>;

const modelsLink = (chunks: React.ReactNode) => (
  <Link href="/settings/models" className="font-medium text-foreground underline underline-offset-2">
    {chunks}
  </Link>
);

/**
 * What embeds memory, journals and knowledge, whether it can right now, and the re-embedding a change
 * starts. Saved on its own, since a change embeds everything again. The page refreshes on the worker's
 * progress events (see LiveUpdates). Both choices run the same model, so there is one to pick only once
 * Ollama is turned on in Settings > Models (or already embeds): before that the built-in model just shows.
 */
export function EmbeddingProviderCard({
  status,
  ollama,
}: {
  status: EmbeddingStatus;
  ollama: { enabled: boolean; baseUrl: string };
}) {
  const t = useTranslations("settings.embeddings");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [choice, setChoice] = useState<EmbeddingProvider>(status.provider);
  const [pending, startTransition] = useTransition();
  const changed = choice !== status.provider;
  const { reindex } = status;
  const label = (provider: EmbeddingProvider) => (provider === "local" ? t("localName") : LABELS[provider]);
  const choosable = ollama.enabled || status.provider === "ollama";

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await setEmbeddingProvider({ provider: choice });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved", { provider: label(choice), count: res.data.total }));
      router.refresh();
    });
  }

  return (
    <FormSection id="embeddings" icon={ScanSearch} title={t("title")} description={t("description")}>
      <form onSubmit={save} className="flex flex-col gap-4">
        {choosable ? (
          <OptionCards<EmbeddingProvider>
            name="embedding-provider"
            label={t("title")}
            value={choice}
            onValueChange={setChoice}
            options={[
              { value: "local", icon: Cpu, title: t("localTitle"), description: t("localHint") },
              { value: "ollama", icon: HardDrive, title: LABELS.ollama, description: t("ollamaHint") },
            ]}
          />
        ) : (
          <div className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 dark:bg-input/20">
            <Cpu className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{t("localTitle")}</span>
              <span className="text-xs text-muted-foreground">{t("localHint")}</span>
            </span>
          </div>
        )}
        <Readiness readiness={status.readiness[choice]} ollamaBaseUrl={ollama.baseUrl} />
        {!choosable && <p className="text-xs text-muted-foreground">{t.rich("ollamaOff", { link: modelsLink })}</p>}
        {reindex && !changed && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
            <p className="flex items-center gap-2">
              {reindex.error ? (
                <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              ) : (
                <Spinner className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="tabular min-w-0">
                {t("reindexing", {
                  provider: label(reindex.provider),
                  done: Math.min(reindex.done, reindex.total),
                  total: reindex.total,
                })}
              </span>
            </p>
            <Progress
              value={reindex.total ? (100 * Math.min(reindex.done, reindex.total)) / reindex.total : 0}
              aria-label={t("reindexProgress")}
            />
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {reindex.error ? t("reindexPaused", { error: reindex.error }) : t("reindexHint")}
            </p>
          </div>
        )}
        {/* Shown only for a change, so it does not compete with the page's save bar. */}
        {changed && (
          <>
            <ProviderNotice>{t("changeNotice", { provider: label(choice) })}</ProviderNotice>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setChoice(status.provider)} disabled={pending}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : <Save />} {tc("save")}
              </Button>
            </div>
          </>
        )}
      </form>
    </FormSection>
  );
}

/** Whether the chosen provider can embed now, and what to do when it cannot. */
function Readiness({ readiness, ollamaBaseUrl }: { readiness: EmbeddingReadiness; ollamaBaseUrl: string }) {
  const t = useTranslations("settings.embeddings.readiness");
  if (readiness === "ready") {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        {t("ready")}
      </p>
    );
  }
  return (
    <ProviderNotice tone="warning">
      {readiness === "local-loading"
        ? t("localLoading")
        : readiness === "local-failed"
          ? t("localFailed")
          : readiness === "ollama-unreachable"
            ? t.rich("ollamaUnreachable", { url: ollamaBaseUrl, mono })
            : t.rich("ollamaModelMissing", { mono })}
    </ProviderNotice>
  );
}

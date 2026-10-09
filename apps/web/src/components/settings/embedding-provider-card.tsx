"use client";

import type { EmbeddingProvider, EmbeddingReadiness } from "@abotica/core";
import { CircleAlert, CircleCheck, Cloud, Cpu, HardDrive, Save, ScanSearch } from "lucide-react";
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
const LABELS: Record<Exclude<EmbeddingProvider, "local">, string> = { openai: "OpenAI", ollama: "Ollama" };

const mono = (chunks: React.ReactNode) => <span className="font-mono text-xs">{chunks}</span>;

/**
 * What embeds memory, journals and knowledge, whether it can right now, and the re-embedding a change
 * starts. Saved on its own, since a change embeds everything again. The page refreshes on the worker's
 * progress events (see LiveUpdates).
 */
export function EmbeddingProviderCard({ status, ollamaBaseUrl }: { status: EmbeddingStatus; ollamaBaseUrl: string }) {
  const t = useTranslations("settings.embeddings");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [choice, setChoice] = useState<EmbeddingProvider>(status.provider);
  const [pending, startTransition] = useTransition();
  const changed = choice !== status.provider;
  const { reindex } = status;
  const label = (provider: EmbeddingProvider) => (provider === "local" ? t("localName") : LABELS[provider]);

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
        <OptionCards<EmbeddingProvider>
          name="embedding-provider"
          label={t("title")}
          value={choice}
          onValueChange={setChoice}
          options={[
            { value: "local", icon: Cpu, title: t("localTitle"), description: t("localHint") },
            { value: "openai", icon: Cloud, title: LABELS.openai, description: t("openaiHint") },
            { value: "ollama", icon: HardDrive, title: LABELS.ollama, description: t("ollamaHint") },
          ]}
        />
        <Readiness readiness={status.readiness[choice]} ollamaBaseUrl={ollamaBaseUrl} />
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
          : readiness === "no-openai-key"
            ? t("noOpenaiKey")
            : readiness === "ollama-unreachable"
              ? t.rich("ollamaUnreachable", { url: ollamaBaseUrl, mono })
              : t.rich("ollamaModelMissing", { mono })}
    </ProviderNotice>
  );
}

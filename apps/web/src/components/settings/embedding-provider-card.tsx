"use client";

import type { EmbeddingProvider, EmbeddingReadiness } from "@abotica/core";
import { Cpu, HardDrive, type LucideIcon, Save, ScanSearch } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { setEmbeddingProvider } from "@/server/actions/settings";
import type { EmbeddingStatus } from "@/server/queries/embeddings";
import { ProviderNotice } from "./provider-notice";

const ICONS: Record<EmbeddingProvider, LucideIcon> = { local: Cpu, ollama: HardDrive };

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
  const choosable = ollama.enabled || status.provider === "ollama";
  const providers: EmbeddingProvider[] = choosable ? ["local", "ollama"] : ["local"];

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await setEmbeddingProvider({ provider: choice });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved", { provider: t(`${choice}.name`), count: res.data.total }));
      router.refresh();
    });
  }

  return (
    <FormSection id="embeddings" icon={ScanSearch} title={t("title")} description={t("description")}>
      <form onSubmit={save} className="flex flex-col gap-3">
        <div
          role={choosable ? "radiogroup" : undefined}
          aria-label={choosable ? t("title") : undefined}
          className={cn("grid gap-3", choosable && "sm:grid-cols-2")}
        >
          {providers.map((provider) => (
            <ProviderOption
              key={provider}
              provider={provider}
              readiness={status.readiness[provider]}
              current={provider === status.provider}
              selected={provider === choice}
              onSelect={choosable ? () => setChoice(provider) : undefined}
            />
          ))}
        </div>

        <Problem readiness={status.readiness[choice]} ollamaBaseUrl={ollama.baseUrl} />
        {status.reindex && !changed && <Reindex reindex={status.reindex} />}

        {changed ? (
          <>
            <ProviderNotice>{t("changeNotice", { provider: t(`${choice}.name`) })}</ProviderNotice>
            {/* Shown only for a change, so it does not compete with the page's save bar. */}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setChoice(status.provider)} disabled={pending}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner /> : <Save />} {tc("save")}
              </Button>
            </div>
          </>
        ) : (
          !choosable && <p className="px-1 text-xs text-muted-foreground">{t.rich("ollamaOff", { link: modelsLink })}</p>
        )}
      </form>
    </FormSection>
  );
}

/**
 * One place the model can run: what it is, where it runs, and whether it can embed now. A radio card when
 * there is a choice, a plain card when there is not.
 */
function ProviderOption({
  provider,
  readiness,
  current,
  selected,
  onSelect,
}: {
  provider: EmbeddingProvider;
  readiness: EmbeddingReadiness;
  current: boolean;
  selected: boolean;
  onSelect?: () => void;
}) {
  const t = useTranslations("settings.embeddings");
  const Icon = ICONS[provider];
  const own = provider === "local" ? "size" : "gpu";
  const Wrapper = onSelect ? "label" : "div";
  return (
    <Wrapper
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card transition-colors dark:bg-input/20",
        onSelect &&
          "cursor-pointer hover:bg-muted/40 has-checked:border-primary/50 has-checked:bg-primary/5 has-checked:ring-1 has-checked:ring-primary/30 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-checked:bg-primary/10",
      )}
    >
      {onSelect && (
        <input
          type="radio"
          name="embedding-provider"
          value={provider}
          checked={selected}
          onChange={onSelect}
          className="sr-only"
        />
      )}
      <div className="flex items-center gap-3 p-3 sm:p-4">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
            selected && "bg-primary/10 text-primary",
          )}
        >
          <Icon className="size-4.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold tracking-tight">{t(`${provider}.title`)}</span>
          <span className="text-xs text-muted-foreground">{t(`${provider}.where`)}</span>
        </span>
        <ReadinessBadge readiness={readiness} current={current} />
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2.5 sm:px-4">
        {/* Side by side, a card keeps only what sets it apart: the model and its privacy are the same. */}
        {(onSelect ? ([own] as const) : (["languages", "private", own] as const)).map((fact) => (
          <Badge key={fact} variant="outline" className="font-normal text-muted-foreground">
            {t(`facts.${fact}`)}
          </Badge>
        ))}
      </div>
    </Wrapper>
  );
}

/** In use and ready, ready to switch to, loading, or what keeps it from embedding, in a word. */
function ReadinessBadge({ readiness, current }: { readiness: EmbeddingReadiness; current: boolean }) {
  const t = useTranslations("settings.embeddings.badge");
  if (readiness === "ready") {
    return (
      <Badge
        className={cn("shrink-0 font-normal", current ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {t(current ? "active" : "available")}
      </Badge>
    );
  }
  if (readiness === "local-loading") {
    return (
      <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
        <Spinner className="size-3" />
        {t("loading")}
      </Badge>
    );
  }
  return (
    <Badge className="shrink-0 bg-warning/15 font-normal text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t(readiness === "local-failed" ? "failed" : readiness === "ollama-unreachable" ? "unreachable" : "missing")}
    </Badge>
  );
}

/** What to do when the chosen place cannot embed; nothing when it can. */
function Problem({ readiness, ollamaBaseUrl }: { readiness: EmbeddingReadiness; ollamaBaseUrl: string }) {
  const t = useTranslations("settings.embeddings.readiness");
  if (readiness === "ready") return null;
  return (
    <ProviderNotice tone={readiness === "local-loading" ? "info" : "warning"}>
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

/** The re-embedding in progress: how far it is, or why it is paused. */
function Reindex({ reindex }: { reindex: NonNullable<EmbeddingStatus["reindex"]> }) {
  const t = useTranslations("settings.embeddings");
  const done = Math.min(reindex.done, reindex.total);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          {!reindex.error && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
          {t("reindexing", { provider: t(`${reindex.provider}.name`) })}
        </span>
        <span className="tabular shrink-0 text-xs text-muted-foreground">
          {done} / {reindex.total}
        </span>
      </div>
      <Progress value={reindex.total ? (100 * done) / reindex.total : 0} aria-label={t("reindexProgress")} />
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {reindex.error ? t("reindexPaused", { error: reindex.error }) : t("reindexHint")}
      </p>
    </div>
  );
}

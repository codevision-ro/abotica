"use client";

import type { FetchedSkill, SkillsShResult } from "@abotica/core";
import { ArrowRightIcon, CheckIcon, DownloadIcon, ExternalLinkIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { chipVariants } from "@/components/app/selectable-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { SEARCH_DEBOUNCE_MS } from "@/lib/search";
import { cn } from "@/lib/utils";
import { fetchSkillPreview, searchSkillsSh } from "@/server/actions/skills";
import { SkillIcon } from "./skill-icon";
import { SkillPreview, SkillPreviewSkeleton, useInstallSkill } from "./skill-preview";

/** Starting points while the search is empty; skills.sh has no public list of popular skills to show instead. */
const TOPICS = ["pdf", "react", "design", "testing", "seo", "marketing", "database", "writing"];

const MIN_QUERY = 2;

type Search = { query: string; results: SkillsShResult[] } | { query: string; error: string };

/**
 * Search of the skills.sh directory. The query lives in ?q= so reload and back keep it; only the
 * newest request may update the results. A result opens a preview sheet with the install action.
 */
export function SkillDiscover({
  initialQuery,
  installed,
}: {
  initialQuery: string;
  /** Installed skills by source key (`listInstalledSources`). */
  installed: Record<string, string>;
}) {
  const t = useTranslations("skills.discover");
  const tc = useTranslations("common.actions");
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState<Search | null>(null);
  const [pending, setPending] = useState(initialQuery.trim().length >= MIN_QUERY);
  const [selected, setSelected] = useState<SkillsShResult | null>(null);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = useCallback(async (q: string) => {
    const request = ++latest.current;
    writeQuery(q);
    const res = await searchSkillsSh({ query: q });
    if (request !== latest.current) return;
    setPending(false);
    setSearch(res.ok ? { query: q, results: res.data } : { query: q, error: res.error });
  }, []);

  // Restores the search from the URL once; later server refreshes pass the same query back.
  const [restored] = useState(() => initialQuery.trim());
  useEffect(() => {
    if (restored.length >= MIN_QUERY) void run(restored);
    return () => clearTimeout(timer.current);
  }, [restored, run]);

  function update(value: string, delay = SEARCH_DEBOUNCE_MS) {
    setQuery(value);
    clearTimeout(timer.current);
    const q = value.trim();
    if (q.length < MIN_QUERY) {
      latest.current++;
      writeQuery(q);
      setPending(false);
      setSearch(null);
      return;
    }
    setPending(true);
    timer.current = setTimeout(() => void run(q), delay);
  }

  const q = query.trim();
  const results = search && "results" in search ? search.results : null;

  return (
    <div className="flex flex-col gap-4">
      <InputGroup className="max-w-xl">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={query}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !query) return;
            e.preventDefault();
            update("");
          }}
          placeholder={t("search")}
          aria-label={t("searchAria")}
          enterKeyHint="search"
          className="[&::-webkit-search-cancel-button]:hidden"
        />
        <InputGroupAddon align="inline-end">
          {pending && <Spinner />}
          {query && (
            <InputGroupButton size="icon-xs" onClick={() => update("")} aria-label={t("clear")}>
              <XIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>

      {q.length < MIN_QUERY ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
          <div className="flex flex-wrap gap-2">
            {TOPICS.map((topic) => (
              <button key={topic} type="button" onClick={() => update(topic, 0)} className={chipVariants()}>
                <SearchIcon aria-hidden />
                {topic}
              </button>
            ))}
          </div>
        </div>
      ) : search && "error" in search && !pending ? (
        <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {search.error}
          <Button variant="outline" size="sm" onClick={() => update(query, 0)}>
            {tc("retry")}
          </Button>
        </p>
      ) : !results ? (
        <ResultsSkeleton />
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {pending ? t("searching") : t("noResults", { query: search!.query })}
        </p>
      ) : (
        <ul
          aria-busy={pending}
          aria-label={t("resultsLabel", { query: search!.query })}
          className={cn("grid grid-cols-1 gap-3 transition-opacity sm:grid-cols-2 xl:grid-cols-3", pending && "opacity-60")}
        >
          {results.map((r) => (
            <ResultCard key={r.id} result={r} installedId={installed[r.id]} onOpen={() => setSelected(r)} />
          ))}
        </ul>
      )}

      <PreviewSheet
        result={selected}
        installedId={selected ? installed[selected.id] : undefined}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

/** ?q= without a navigation: the server page reads it only on load, to restore the search. */
function writeQuery(q: string) {
  const url = new URL(window.location.href);
  if (q) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}

function ResultCard({ result, installedId, onOpen }: { result: SkillsShResult; installedId?: string; onOpen: () => void }) {
  const t = useTranslations("skills.discover");
  const format = useFormatter();
  return (
    <li className="group relative flex min-w-0 items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:border-primary/40 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
      <SkillIcon size="md" />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          title={result.name}
          className="block max-w-full truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl"
        >
          {result.name}
        </button>
        <p className="truncate font-mono text-xs text-muted-foreground" title={result.source}>
          {result.source}
        </p>
      </div>
      <span
        className="tabular inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        title={t("installs", { count: result.installs })}
      >
        <DownloadIcon className="size-3.5" aria-hidden />
        <span aria-hidden>{format.number(result.installs, { notation: "compact", maximumFractionDigits: 1 })}</span>
        <span className="sr-only">{t("installs", { count: result.installs })}</span>
      </span>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {installedId && (
          <Badge variant="secondary" asChild>
            <Link href={`/skills/${installedId}`}>
              <CheckIcon aria-hidden /> {t("installed")}
            </Link>
          </Badge>
        )}
        <Button variant="ghost" size="icon-sm" asChild>
          <a
            href={`https://skills.sh/${result.id}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("openOnSkillsSh", { name: result.name })}
            title={t("openOnSkillsSh", { name: result.name })}
          >
            <ExternalLinkIcon />
          </a>
        </Button>
      </div>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border bg-card p-3">
          <Skeleton className="size-7 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-3.5 w-10" />
        </div>
      ))}
    </div>
  );
}

type Preview = { id: string; skill?: FetchedSkill; error?: string };

/** Wide right sheet (full screen on phones) with the skill's files and the install action. */
function PreviewSheet({
  result,
  installedId,
  onClose,
}: {
  result: SkillsShResult | null;
  installedId?: string;
  onClose: () => void;
}) {
  const t = useTranslations("skills.discover");
  const tp = useTranslations("skills.preview");
  const tc = useTranslations("common.actions");
  const { install, pending } = useInstallSkill();
  const [preview, setPreview] = useState<Preview | null>(null);
  // Keep the last result rendered while the close animation runs.
  const [shown, setShown] = useState(result);
  if (result && result !== shown) setShown(result);

  // Only the newest selection may fill the preview.
  const latest = useRef<string | null>(null);
  const load = useCallback(async (id: string) => {
    latest.current = id;
    const res = await fetchSkillPreview({ ref: { kind: "skills.sh", id } });
    if (latest.current === id) setPreview(res.ok ? { id, skill: res.data } : { id, error: res.error });
  }, []);

  const id = result?.id;
  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  const current = shown && preview?.id === shown.id ? preview : null;

  return (
    <Sheet open={!!result} onOpenChange={(open) => !open && !pending && onClose()}>
      <SheetContent
        className="w-full gap-0 bg-background p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl data-[side=right]:xl:max-w-4xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetTitle className="sr-only">{shown?.name}</SheetTitle>
        <SheetDescription className="sr-only">{t("sheetDescription")}</SheetDescription>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-12 md:p-6 md:pt-12">
          {current?.skill ? (
            <SkillPreview
              key={current.id}
              pkg={current.skill.pkg}
              skipped={current.skill.skipped}
              source={{ kind: "remote", origin: current.skill.source }}
            />
          ) : current?.error ? (
            <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {current.error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPreview(null);
                  void load(current.id);
                }}
              >
                {tc("retry")}
              </Button>
            </p>
          ) : (
            <SkillPreviewSkeleton />
          )}
        </div>
        <SheetFooter className="flex-row items-center justify-end border-t bg-muted/30 px-4 py-3 md:px-6">
          {installedId ? (
            <>
              <span className="mr-auto text-xs text-muted-foreground">{tp("alreadyInstalled")}</span>
              <Button asChild>
                <Link href={`/skills/${installedId}`}>
                  {tp("openInstalled")} <ArrowRightIcon />
                </Link>
              </Button>
            </>
          ) : (
            <Button disabled={!current?.skill || pending} onClick={() => current?.skill && install(current.skill)}>
              {pending ? <Spinner /> : <DownloadIcon />} {tp("install")}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

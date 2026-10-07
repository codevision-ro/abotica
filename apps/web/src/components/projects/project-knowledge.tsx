"use client";

import { isTextFile } from "@abotica/core/file-types";
import { FILE_MAX_BYTES } from "@abotica/core/limits";
import {
  DownloadIcon,
  FileTextIcon,
  FileUpIcon,
  LibraryIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionList, SectionRow } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/hooks/use-format";
import { uploadFiles } from "@/lib/upload-files";
import {
  createKnowledgeDocument,
  createKnowledgeFile,
  createKnowledgeLink,
  deleteKnowledgeItem,
  reindexKnowledgeItem,
  searchProjectKnowledge,
} from "@/server/actions/projects";
import type { KnowledgeItemRow } from "@/server/queries/projects";

const FILE_MAX_MB = FILE_MAX_BYTES / (1024 * 1024);

const KIND_ICON = {
  document: FileTextIcon,
  link: LinkIcon,
  file: FileUpIcon,
} as const;

export function ProjectKnowledge({ projectId, items }: { projectId: string; items: KnowledgeItemRow[] }) {
  const t = useTranslations("projects.knowledge");
  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        icon={LibraryIcon}
        title={t("title")}
        count={items.length}
        description={t("intro")}
        action={<AddKnowledgeDialog projectId={projectId} />}
        flush
      >
        {items.length ? (
          <SectionList>
            {items.map((item) => (
              <KnowledgeRow key={item.id} projectId={projectId} item={item} />
            ))}
          </SectionList>
        ) : (
          <SectionEmpty>{t("empty")}</SectionEmpty>
        )}
      </SectionCard>

      {items.length > 0 && <KnowledgeSearch projectId={projectId} />}
    </div>
  );
}

function KnowledgeRow({ projectId, item }: { projectId: string; item: KnowledgeItemRow }) {
  const t = useTranslations("projects.knowledge");
  const tc = useTranslations("common");
  const tFiles = useTranslations("files");
  const locale = useLocale();
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();
  const Icon = KIND_ICON[item.kind];
  const { file } = item;
  // A file that is not text is stored for download only; reindexing it would find nothing to index.
  const indexable = !file || isTextFile(file.mimeType, file.name);
  const size = file
    ? fmt.fileSize(file.size)
    : item.size < 1_000
      ? t("chars", { count: item.size })
      : t("charsThousands", {
          value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(item.size / 1_000),
        });

  function remove() {
    startTransition(async () => {
      const res = await deleteKnowledgeItem({ id: item.id, projectId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("deleted"));
    });
  }

  function reindex() {
    startTransition(async () => {
      const res = await reindexKnowledgeItem({ id: item.id, projectId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("reindexed", { count: res.data.chunks }));
    });
  }

  return (
    <SectionRow
      media={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
      }
      title={<span title={item.title}>{item.title}</span>}
      subtitle={
        <>
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              title={item.sourceUrl}
              className="hover:text-primary hover:underline"
            >
              {item.sourceUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            t(`kinds.${item.kind}`)
          )}
          <span className="tabular">
            {" · "}
            {size} · {item.chunks || indexable ? t("chunks", { count: item.chunks }) : t("notSearchable")} ·{" "}
            <RelativeTime date={item.createdAt} />
          </span>
        </>
      }
      trailing={
        <div className="flex items-center gap-1">
          {file && (
            <Button size="icon-sm" variant="ghost" asChild>
              <a
                href={`/api/files/${file.id}`}
                download={file.name}
                aria-label={tFiles("downloadName", { name: file.name })}
                title={tFiles("downloadName", { name: file.name })}
              >
                <DownloadIcon />
              </a>
            </Button>
          )}
          {indexable && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("reindex")}
              title={t("reindex")}
              onClick={reindex}
              disabled={pending}
            >
              <RefreshCwIcon />
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tc("actions.delete")}
                title={tc("actions.delete")}
                className="text-muted-foreground hover:text-destructive"
                disabled={pending}
              >
                {pending ? <Spinner /> : <Trash2Icon />}
              </Button>
            }
            title={tc("confirmDelete.title", { name: item.title })}
            description={t("deleteDescription")}
            titleClassName="break-words"
            confirm={tc("actions.delete")}
            destructive
            onConfirm={remove}
          />
        </div>
      }
    />
  );
}

function AddKnowledgeDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("projects.knowledge");
  const tc = useTranslations("common");
  const tFiles = useTranslations("files");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("document");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  /** Share of the file uploaded so far; null when no upload runs. */
  const [progress, setProgress] = useState<number | null>(null);

  function reset() {
    setTitle("");
    setContent("");
    setUrl("");
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      let res;
      if (tab === "document") {
        res = await createKnowledgeDocument({ projectId, title, content });
      } else if (tab === "link") {
        res = await createKnowledgeLink({ projectId, url });
      } else {
        const file = fileRef.current?.files?.[0];
        if (!file) return setError(t("add.fileRequired"));
        if (file.size > FILE_MAX_BYTES) return setError(tFiles("errors.tooLarge", { name: file.name, max: FILE_MAX_MB }));
        try {
          const [uploaded] = await uploadFiles([{ data: file, name: file.name }], {
            onProgress: setProgress,
            fallbackError: tFiles("errors.uploadFailed"),
          });
          res = await createKnowledgeFile({ projectId, fileId: uploaded!.id });
        } catch (error) {
          return setError(error instanceof Error ? error.message : tFiles("errors.uploadFailed"));
        } finally {
          setProgress(null);
        }
      }
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.data.chunks ? t("add.added", { count: res.data.chunks }) : t("add.storedOnly"));
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          {tc("actions.add")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        // An accidental click outside must not discard a pasted document or typed URL.
        onInteractOutside={(e) => (title.trim() || content.trim() || url.trim()) && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Tabs value={tab} onValueChange={(v) => (setTab(v), setError(null))}>
            <TabsList className="w-full">
              <TabsTrigger value="document">
                <FileTextIcon />
                {t("kinds.document")}
              </TabsTrigger>
              <TabsTrigger value="link">
                <LinkIcon />
                {t("kinds.link")}
              </TabsTrigger>
              <TabsTrigger value="file">
                <FileUpIcon />
                {t("kinds.file")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="document" className="pt-2">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="kb-title">{t("add.titleLabel")}</FieldLabel>
                  <Input
                    id="kb-title"
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t("add.titlePlaceholder")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="kb-content">{t("add.contentLabel")}</FieldLabel>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t("add.contentPlaceholder")}
                    rows={10}
                    className="max-h-[40vh] font-mono text-xs"
                  />
                </Field>
              </FieldGroup>
            </TabsContent>
            <TabsContent value="link" className="pt-2">
              <Field>
                <FieldLabel htmlFor="kb-url">{t("add.urlLabel")}</FieldLabel>
                <Input
                  id="kb-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t("add.urlPlaceholder")}
                />
                <FieldDescription>{t("add.urlHint")}</FieldDescription>
              </Field>
            </TabsContent>
            <TabsContent value="file" className="pt-2">
              <Field>
                <FieldLabel htmlFor="kb-file">{t("add.fileLabel")}</FieldLabel>
                <Input id="kb-file" ref={fileRef} type="file" disabled={pending} />
                <FieldDescription>{t("add.fileHint", { max: FILE_MAX_MB })}</FieldDescription>
              </Field>
            </TabsContent>
          </Tabs>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {tc("actions.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {progress !== null ? (
                <span className="tabular">{t("add.uploading", { percent: Math.round(progress * 100) })}</span>
              ) : tab === "link" ? (
                t("add.fetchAndAdd")
              ) : (
                tc("actions.add")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KnowledgeSearch({ projectId }: { projectId: string }) {
  const t = useTranslations("projects.knowledge.search");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ title: string; sourceUrl: string | null; content: string }[] | null>(null);
  const [pending, startTransition] = useTransition();

  function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    startTransition(async () => {
      const res = await searchProjectKnowledge({ projectId, query });
      if (!res.ok) return void toast.error(res.error);
      setResults(res.data);
    });
  }

  return (
    <SectionCard icon={SearchIcon} title={t("title")} description={t("description")}>
      <div className="flex flex-col gap-3">
        <form onSubmit={search} className="flex gap-2">
          <Input
            aria-label={t("label")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("placeholder")}
          />
          <Button type="submit" variant="secondary" disabled={pending || !query.trim()}>
            {pending ? <Spinner /> : <SearchIcon />}
            {tc("actions.search")}
          </Button>
        </form>
        {results &&
          (results.length ? (
            <ol className="flex flex-col gap-2">
              {results.map((r, i) => (
                <li key={i} className="rounded-xl border border-border/60 bg-background/60 p-3 dark:bg-input/20">
                  <p className="mb-1 flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className="tabular">#{i + 1}</span>
                    <span className="min-w-0 truncate" title={r.title}>
                      {r.title}
                    </span>
                  </p>
                  <p className="line-clamp-6 text-sm break-words whitespace-pre-wrap">{r.content}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ))}
      </div>
    </SectionCard>
  );
}

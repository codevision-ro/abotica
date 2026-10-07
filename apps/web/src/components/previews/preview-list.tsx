"use client";

import {
  AppWindowIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  GlobeIcon,
  LockIcon,
  TimerResetIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionList, SectionRow } from "@/components/app/section-card";
import { ToneBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { extendPreview, revokePreview, setPreviewPublic } from "@/server/actions/previews";
import type { PreviewRow } from "@/server/queries/previews";

/** Previews with their actions: open, copy the link, make public or private, extend, take down. */
export function PreviewList({ previews, showOwner }: { previews: PreviewRow[]; showOwner: boolean }) {
  const t = useTranslations("previews");
  return (
    <SectionCard icon={AppWindowIcon} title={t("title")} count={previews.length} description={t("intro")} flush>
      {previews.length ? (
        <SectionList>
          {previews.map((preview) => (
            <PreviewItem key={preview.id} preview={preview} showOwner={showOwner} />
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}

function PreviewItem({ preview, showOwner }: { preview: PreviewRow; showOwner: boolean }) {
  const t = useTranslations("previews");
  const [pending, startTransition] = useTransition();
  const Icon = preview.kind === "live" ? AppWindowIcon : FileCode2Icon;
  const values = { title: preview.title };

  function run(task: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const res = await task();
      if (!res.ok) toast.error(res.error);
      else toast.success(success);
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(preview.url);
      toast.success(t("toasts.copied"));
    } catch {
      toast.error(preview.url);
    }
  }

  const makePrivate = () => run(() => setPreviewPublic({ id: preview.id, public: false }), t("toasts.private", values));

  return (
    <SectionRow
      media={
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" title={preview.title}>
            {preview.title}
          </span>
          <ToneBadge tone={preview.public ? "warning" : "muted"}>
            {t(`visibility.${preview.public ? "public" : "private"}`)}
          </ToneBadge>
        </span>
      }
      subtitle={
        <>
          {t(`kinds.${preview.kind}`)}
          {showOwner && (
            <>
              {" · "}
              <Link href={preview.owner.href} className="hover:text-primary hover:underline">
                {preview.owner.kind === "project" ? preview.owner.name : preview.owner.name || t("chat")}
              </Link>
            </>
          )}
          {" · "}
          {t("expires")} <RelativeTime date={preview.expiresAt} />
        </>
      }
      trailing={
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" asChild>
            <a
              href={preview.openHref}
              target="_blank"
              rel="noreferrer"
              aria-label={t("actions.open")}
              title={t("actions.open")}
            >
              <ExternalLinkIcon />
            </a>
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("actions.copy")} title={t("actions.copy")} onClick={copy}>
            <CopyIcon />
          </Button>
          {preview.public ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("actions.makePrivate")}
              title={t("actions.makePrivate")}
              onClick={makePrivate}
              disabled={pending}
            >
              <LockIcon />
            </Button>
          ) : (
            <ConfirmDialog
              trigger={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("actions.makePublic")}
                  title={t("actions.makePublic")}
                  disabled={pending}
                >
                  <GlobeIcon />
                </Button>
              }
              title={t("confirmPublic.title", values)}
              description={t("confirmPublic.description")}
              titleClassName="break-words"
              confirm={t("actions.makePublic")}
              onConfirm={() => run(() => setPreviewPublic({ id: preview.id, public: true }), t("toasts.public", values))}
            />
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("actions.extend")}
            title={t("actions.extend")}
            onClick={() => run(() => extendPreview({ id: preview.id }), t("toasts.extended", values))}
            disabled={pending}
          >
            <TimerResetIcon />
          </Button>
          <ConfirmDialog
            trigger={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("actions.takeDown")}
                title={t("actions.takeDown")}
                className="text-muted-foreground hover:text-destructive"
                disabled={pending}
              >
                {pending ? <Spinner /> : <Trash2Icon />}
              </Button>
            }
            title={t("confirmTakeDown.title", values)}
            description={t("confirmTakeDown.description")}
            titleClassName="break-words"
            confirm={t("actions.takeDown")}
            destructive
            onConfirm={() => run(() => revokePreview({ id: preview.id }), t("toasts.takenDown", values))}
          />
        </div>
      }
    />
  );
}

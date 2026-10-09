"use client";

import type { SkillSource } from "@abotica/db";
import { ArrowUpCircleIcon, CheckIcon, ExternalLinkIcon, PackageIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { sectionCardClass, SectionIcon } from "@/components/app/section-card";
import { ToneBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { checkSkillUpdate, syncSkill } from "@/server/actions/skills";

type UpdateCheck = "checking" | "current" | "available" | "failed";

/** "owner/repo/skill" on skills.sh, "owner/repo/path" on GitHub. */
function skillSourceLabel(source: SkillSource): string {
  return source.kind === "skills.sh" ? source.id : [source.repo, source.path].filter(Boolean).join("/");
}

/**
 * Where an installed skill came from, in one quiet row. After mount it asks the source whether a newer
 * version exists and offers the update; a failed check stays silent apart from a retry button.
 */
export function SkillSourceBanner({
  skillId,
  source,
  modified: initialModified,
  dirty,
}: {
  skillId: string;
  source: SkillSource;
  /** Saved content differs from what was installed. */
  modified: boolean;
  /** The form has unsaved edits, which the update would also drop. */
  dirty: boolean;
}) {
  const t = useTranslations("skills.source");
  const router = useRouter();
  const [check, setCheck] = useState<UpdateCheck>("checking");
  const [attempt, setAttempt] = useState(0);
  const [modified, setModified] = useState(initialModified);
  const [syncing, startSync] = useTransition();

  useEffect(() => {
    let cancelled = false;
    checkSkillUpdate({ id: skillId })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) return setCheck("failed");
        setModified(res.data.modified);
        setCheck(res.data.updateAvailable ? "available" : "current");
      })
      .catch(() => !cancelled && setCheck("failed"));
    return () => {
      cancelled = true;
    };
  }, [skillId, attempt]);

  function update() {
    startSync(async () => {
      const res = await syncSkill({ id: skillId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.data.changed.length ? t("updated", { version: res.data.version }) : t("alreadyCurrent"));
      setCheck("current");
      router.refresh();
    });
  }

  const updateButton = (onClick?: () => void) => (
    <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={onClick}>
      {syncing ? <Spinner /> : <ArrowUpCircleIcon />} {t("update")}
    </Button>
  );

  return (
    <div className={cn(sectionCardClass, "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-5")}>
      <SectionIcon icon={PackageIcon} />
      <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">{t(source.kind === "skills.sh" ? "fromSkillsSh" : "fromGithub")}</span>
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          title={t("open")}
          className="inline-flex min-w-0 items-center gap-1 rounded font-mono text-[13px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="truncate">{skillSourceLabel(source)}</span>
          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="sr-only">({t("newTab")})</span>
        </a>
        {modified && (
          <ToneBadge tone="warning" title={t("modifiedHint")}>
            {t("modified")}
          </ToneBadge>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {check === "checking" && (
          <>
            <Spinner className="size-3.5" /> {t("checking")}
          </>
        )}
        {check === "current" && (
          <>
            <CheckIcon className="size-3.5" aria-hidden /> {t("upToDate")}
          </>
        )}
        {check === "failed" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("retry")}
            title={t("retry")}
            onClick={() => {
              setCheck("checking");
              setAttempt((n) => n + 1);
            }}
          >
            <RefreshCwIcon />
          </Button>
        )}
        {check === "available" && (
          <>
            <span className="font-medium text-foreground">{t("available")}</span>
            {modified || dirty ? (
              <ConfirmDialog
                trigger={updateButton()}
                title={t("confirmTitle")}
                description={[modified && t("confirmModified"), dirty && t("confirmUnsaved")].filter(Boolean).join(" ")}
                confirm={t("update")}
                onConfirm={update}
              />
            ) : (
              updateButton(update)
            )}
          </>
        )}
      </div>
    </div>
  );
}

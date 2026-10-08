"use client";

import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type Tone, ToneBadge } from "@/components/app/status-badge";
import { cn } from "@/lib/utils";
import type { TaskPullRequestBadge } from "@/server/queries/tasks";

type Status = "merged" | "closed" | "checksFailing" | "changesRequested" | "checksPending" | "approved" | "open";

const TONE: Record<Status, Tone> = {
  merged: "success",
  closed: "muted",
  checksFailing: "destructive",
  changesRequested: "warning",
  checksPending: "primary",
  approved: "success",
  open: "primary",
};

/** What needs attention first: the end state, then failing CI, then the review. */
function statusOf(pr: TaskPullRequestBadge): Status {
  if (pr.state !== "open") return pr.state;
  if (pr.checks === "failure") return "checksFailing";
  if (pr.review === "changes_requested") return "changesRequested";
  if (pr.checks === "pending") return "checksPending";
  return pr.review === "approved" ? "approved" : "open";
}

/** `#12` on GitHub, `!12` on GitLab. */
const label = (pr: TaskPullRequestBadge) => `${pr.provider === "gitlab" ? "!" : "#"}${pr.number}`;

/**
 * A pull request of the task with where it stands, linking to it on GitHub or GitLab. Above the card's
 * own link, so a click opens the pull request.
 */
export function PullRequestBadge({ pr, className }: { pr: TaskPullRequestBadge; className?: string }) {
  const t = useTranslations("tasks.pr");
  const status = statusOf(pr);
  const text = t(`badge.${status}`);
  const Icon = pr.state === "merged" ? GitMergeIcon : pr.state === "closed" ? GitPullRequestClosedIcon : GitPullRequestIcon;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      draggable={false}
      title={t("title", { label: label(pr), status: text })}
      className={cn("relative z-10 inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      <ToneBadge tone={TONE[status]} pulse={status === "checksPending"}>
        <Icon className="size-3" aria-hidden />
        <span className="tabular">{label(pr)}</span>
        {text}
      </ToneBadge>
    </a>
  );
}

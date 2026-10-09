import { CircleCheckIcon, FolderKanbanIcon, ListTodoIcon, TargetIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listCardClass } from "@/components/app/section-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import type { ProjectListItem } from "@/server/queries/projects";
import { AgentAvatarStack, ProjectStatusBadge } from "./project-badges";

/** Same card as the agent and MCP lists: quiet border, primary tint on hover, the name link covers the card. */
export async function ProjectCard({ project }: { project: ProjectListItem }) {
  const [t, fmt] = await Promise.all([getTranslations("projects.card"), getFormat()]);
  const budget = project.budgetUsd;
  const over = budget !== null && project.monthSpend > budget;
  const b = (chunks: React.ReactNode) => <b className="font-medium text-foreground">{chunks}</b>;

  return (
    <div className={cn(listCardClass, project.status === "archived" && "opacity-70")}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06)] dark:bg-primary/15 dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
        >
          <FolderKanbanIcon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/projects/${project.id}`}
            title={project.name}
            className="line-clamp-2 font-medium wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
          >
            {project.name}
          </Link>
        </div>
        <ProjectStatusBadge status={project.status} />
      </div>

      {(project.description || project.goals) && (
        <div className="space-y-1.5 text-sm text-muted-foreground">
          {project.description && (
            <p className="line-clamp-2 text-pretty wrap-anywhere" title={project.description}>
              {project.description}
            </p>
          )}
          {project.goals && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs">
              <TargetIcon className="size-3.5 shrink-0" aria-label={t("goals")} />
              <span className="truncate" title={project.goals}>
                {project.goals}
              </span>
            </p>
          )}
        </div>
      )}

      <div className="mt-auto space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t("monthSpend")}</span>
            <span className={cn("tabular", over && "text-destructive")}>
              {budget !== null
                ? t.rich("spendOfBudget", {
                    spend: fmt.usd(project.monthSpend),
                    budget: fmt.usd(budget),
                    b: (chunks) => (
                      <b className={cn("font-medium", over ? "text-destructive" : "text-foreground")}>{chunks}</b>
                    ),
                  })
                : t.rich("spendNoBudget", { spend: fmt.usd(project.monthSpend), b })}
            </span>
          </div>
          {budget !== null && (
            <Progress
              value={budget ? Math.min(100, (project.monthSpend / budget) * 100) : 100}
              className={cn("h-1.5", over && "[&>[data-slot=progress-indicator]]:bg-destructive")}
            />
          )}
        </div>

        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3">
          <AgentAvatarStack agents={project.agents} />
          <div className="tabular flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ListTodoIcon className="size-3.5" aria-hidden />
              {t.rich("openTasks", { count: project.openTasks, b })}
            </span>
            <span className="inline-flex items-center gap-1">
              <CircleCheckIcon className="size-3.5" aria-hidden />
              {t.rich("doneTasks", { count: project.doneTasks, b })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

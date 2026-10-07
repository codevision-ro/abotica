import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { TaskList } from "@/components/tasks/task-list";
import { TaskNewDialog } from "@/components/tasks/task-new-dialog";
import { NewTaskButton, NewTaskLink, TaskToolbar } from "@/components/tasks/task-toolbar";
import { cn } from "@/lib/utils";
import { isUuid } from "@/lib/uuid";
import { listBoardTasks, getTaskDetail, getTaskOptions } from "@/server/queries/tasks";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("tasks");
  return { title: t("meta.title") };
}

export default async function TasksPage(props: PageProps<"/tasks">) {
  const sp = await props.searchParams;
  const str = (key: string) => (typeof sp[key] === "string" ? (sp[key] as string) : undefined);
  const filters = {
    q: str("q"),
    project: str("project"),
    assignee: str("assignee"),
    priority: str("priority"),
    showAllDone: str("showAllDone") === "1",
  };
  const view = str("view") === "list" ? "list" : "board";
  const taskId = str("task");

  const [tasks, options, detail, t] = await Promise.all([
    listBoardTasks(filters),
    getTaskOptions(),
    isUuid(taskId) ? getTaskDetail(taskId) : null,
    getTranslations("tasks"),
  ]);
  const filtered = !!(filters.q || filters.project || filters.assignee || filters.priority);

  return (
    <div className="flex h-[calc(100svh-3.5rem-1rem)] min-h-0 flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          <Suspense>
            <NewTaskButton />
          </Suspense>
        }
      />
      <Suspense fallback={<Skeleton className="h-8 w-full rounded-lg" />}>
        <TaskToolbar options={options} />
      </Suspense>

      <Suspense fallback={<Skeleton className="min-h-0 flex-1 rounded-2xl" />}>
        {tasks.length === 0 && !filtered && !filters.showAllDone ? (
          <EmptyTasks />
        ) : tasks.length === 0 && view === "list" ? (
          <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>{t("page.noMatches")}</p>
        ) : view === "list" ? (
          <TaskList tasks={tasks} />
        ) : (
          <TaskBoard
            tasks={tasks}
            showAllDone={filters.showAllDone}
            projectId={isUuid(filters.project) ? filters.project : undefined}
          />
        )}
      </Suspense>

      <Suspense>
        <TaskNewDialog options={options} />
        <TaskDetailSheet detail={detail} options={options} />
      </Suspense>
    </div>
  );
}

async function EmptyTasks() {
  const t = await getTranslations("tasks");
  return (
    <p className={cn(sectionCardClass, "px-4 py-4 text-sm text-muted-foreground sm:px-5")}>
      {t.rich("page.empty", {
        link: (chunks) => (
          <Suspense>
            <NewTaskLink>{chunks}</NewTaskLink>
          </Suspense>
        ),
      })}
    </p>
  );
}

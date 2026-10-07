import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageBody } from "@/components/app/page-header";
import { TaskBackLink } from "@/components/tasks/task-back-link";
import { TaskDetail } from "@/components/tasks/task-detail";
import { isUuid } from "@/lib/uuid";
import { getTaskDetail, getTaskOptions } from "@/server/queries/tasks";

export async function generateMetadata(props: PageProps<"/tasks/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const task = isUuid(id) ? await getTaskDetail(id) : null;
  if (task) return { title: task.title };
  const t = await getTranslations("tasks");
  return { title: t("meta.fallbackTitle") };
}

export default async function TaskPage(props: PageProps<"/tasks/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const [task, options, t] = await Promise.all([getTaskDetail(id), getTaskOptions(), getTranslations("tasks")]);
  if (!task) notFound();

  return (
    <PageBody className="max-w-6xl gap-4">
      <TaskBackLink label={t("page.back")} />
      <Suspense>
        <TaskDetail task={task} options={options} mode="page" />
      </Suspense>
    </PageBody>
  );
}

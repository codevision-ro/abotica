import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/app/page-header";
import { OfficeView } from "@/components/office/office-view";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { isUuid } from "@/lib/uuid";
import { getOffice } from "@/server/queries/office";
import { getTaskDetail, getTaskOptions } from "@/server/queries/tasks";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("office");
  return { title: t("meta.title") };
}

export default async function OfficePage(props: PageProps<"/office">) {
  const sp = await props.searchParams;
  const taskId = typeof sp.task === "string" ? sp.task : undefined;

  const [office, options, detail, t] = await Promise.all([
    getOffice(),
    getTaskOptions(),
    isUuid(taskId) ? getTaskDetail(taskId) : null,
    getTranslations("office"),
  ]);

  return (
    <div className="flex h-[calc(100svh-3.5rem-1rem)] min-h-0 flex-col gap-4 p-4 md:p-6">
      <PageHeader title={t("page.title")} description={t("page.description")} />
      <Suspense fallback={<Skeleton className="min-h-0 flex-1 rounded-2xl" />}>
        <OfficeView initial={office} />
      </Suspense>
      <Suspense>
        <TaskDetailSheet detail={detail} options={options} />
      </Suspense>
    </div>
  );
}

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { PreviewList } from "@/components/previews/preview-list";
import { listPreviewRows } from "@/server/queries/previews";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("previews");
  return { title: t("title") };
}

export default async function PreviewsPage() {
  const [t, previews] = await Promise.all([getTranslations("previews"), listPreviewRows()]);
  return (
    <PageBody>
      <PageHeader title={t("title")} description={t("intro")} />
      <PreviewList previews={previews} showOwner />
    </PageBody>
  );
}

import { useTranslations } from "next-intl";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const t = useTranslations("settings.layout");
  return (
    <PageBody>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <aside className="md:w-52 md:shrink-0">
          <div className="md:sticky md:top-18">
            <SettingsNav />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </PageBody>
  );
}

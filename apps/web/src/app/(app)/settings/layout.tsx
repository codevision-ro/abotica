import { useTranslations } from "next-intl";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SettingsSaveBarHost } from "@/components/settings/settings-save-bar";
import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const t = useTranslations("settings.layout");
  return (
    <PageBody className="max-md:gap-4">
      <PageHeader title={t("title")} />
      <div className="flex flex-col gap-5 md:flex-row md:gap-8">
        <aside className="md:w-48 md:shrink-0">
          <div className="md:sticky md:top-18">
            <SettingsNav />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {children}
          {/*
           * The save bar's place: room for it after the last card, and sticky, so while a page scrolls the bar
           * stays at the bottom of the window over this column without taking room between the cards.
           */}
          <div className="pointer-events-none sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 h-14">
            <div className="absolute inset-x-0 bottom-0">
              <SettingsSaveBarHost />
            </div>
          </div>
        </div>
      </div>
    </PageBody>
  );
}

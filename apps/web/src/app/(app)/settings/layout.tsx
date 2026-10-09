import { useTranslations } from "next-intl";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SETTINGS_SAVE_SLOT_ID } from "@/components/settings/settings-save-bar";
import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const t = useTranslations("settings.layout");
  return (
    <PageBody className="max-md:gap-4">
      {/* On a phone the page picker below says where you are: the header keeps only its title. */}
      <PageHeader title={t("title")} description={<span className="max-md:hidden">{t("description")}</span>} />
      <div className="flex flex-col gap-5 md:flex-row md:gap-8">
        <aside className="md:w-52 md:shrink-0">
          {/* Thirteen pages in groups can outgrow a short window: the nav then scrolls on its own. */}
          <div className="md:sticky md:top-18 md:max-h-[calc(100svh-5.5rem)] md:-mx-1 md:overflow-y-auto md:px-1 md:pb-4 md:[scrollbar-width:thin]">
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
            <div id={SETTINGS_SAVE_SLOT_ID} className="absolute inset-x-0 bottom-0 flex flex-col gap-2" />
          </div>
        </div>
      </div>
    </PageBody>
  );
}

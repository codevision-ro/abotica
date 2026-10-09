import { TELEGRAM_COMMANDS } from "@abotica/core/telegram-commands";
import { ListOrdered } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SectionCard } from "@/components/app/section-card";
import { ReportsSettingsForm } from "@/components/settings/reports-settings-form";
import { SectionHeader } from "@/components/settings/section-header";
import { SettingsNote } from "@/components/settings/settings-note";
import { TelegramCommands } from "@/components/settings/telegram-commands";
import { TelegramSettingsForm } from "@/components/settings/telegram-settings-form";
import { getAppSettings, getTelegramStatus } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("telegram") };
}

/** The bot, who may use it and where it writes; the setup steps until a bot is set; then the reports it sends. */
export default async function TelegramPage() {
  const [status, settings, t, tr] = await Promise.all([
    getTelegramStatus(),
    getAppSettings(),
    getTranslations("settings.telegram"),
    getTranslations("settings.reports"),
  ]);
  const mono = (chunks: React.ReactNode) => <span className="font-mono text-[0.9em]">{chunks}</span>;
  const configured = status.tokenUpdatedAt !== null;
  const steps = [
    t.rich("step1", { mono }),
    t.rich("step2", { mono }),
    t.rich("step3", { mono }),
    t.rich("step4", { mono }),
    t.rich("step5", { mono }),
  ];

  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <TelegramSettingsForm
        tokenUpdatedAt={status.tokenUpdatedAt}
        allowedUserIds={status.allowedUserIds}
        notifyChatId={status.notifyChatId}
        bot={status.bot}
      />

      {!configured && (
        <SectionCard icon={ListOrdered} title={t("setupTitle")}>
          <ol className="flex flex-col gap-3.5">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span
                  aria-hidden
                  className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 pt-0.5 text-pretty [overflow-wrap:anywhere]">{step}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      )}

      <TelegramCommands commands={TELEGRAM_COMMANDS} />
      <SettingsNote title={t("transcriptionTitle")}>{t("transcriptionDescription")}</SettingsNote>

      <SectionHeader
        id="reports"
        title={tr("title")}
        description={tr.rich("description", {
          timezone: settings.general.timezone,
          zone: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          link: (chunks) => (
            <Link href="/settings" className="underline underline-offset-4 hover:text-foreground">
              {chunks}
            </Link>
          ),
        })}
      />
      <ReportsSettingsForm initial={settings.reports} />
    </>
  );
}

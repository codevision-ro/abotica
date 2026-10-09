import { TELEGRAM_COMMANDS } from "@abotica/core/telegram-commands";
import { FolderKanban, Hash, ListOrdered, SquareSlash } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionEmpty, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { SectionHeader } from "@/components/settings/section-header";
import { SettingsNote } from "@/components/settings/settings-note";
import { TelegramSettingsForm } from "@/components/settings/telegram-settings-form";
import { Badge } from "@/components/ui/badge";
import { getTelegramStatus } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("telegram") };
}

export default async function TelegramPage() {
  const [status, t, tb] = await Promise.all([
    getTelegramStatus(),
    getTranslations("settings.telegram"),
    getTranslations("telegram.commands"),
  ]);
  const mono = (chunks: React.ReactNode) => <span className="font-mono text-[0.9em]">{chunks}</span>;
  const statusLabel = (value: string) => {
    const key = `projectStatus.${value}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : value;
  };
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

      <SectionCard icon={SquareSlash} title={t("commandsTitle")} description={t("commandsDescription")} flush>
        <SectionList>
          {TELEGRAM_COMMANDS.map((command) => (
            <li key={command} className="flex min-w-0 items-baseline gap-3 px-4 py-2.5 sm:px-5">
              <span className="w-20 shrink-0 font-mono text-sm font-medium">/{command}</span>
              <span className="min-w-0 text-sm text-pretty text-muted-foreground">{tb(command)}</span>
            </li>
          ))}
        </SectionList>
      </SectionCard>

      <SectionCard
        icon={Hash}
        title={t("topicsTitle")}
        count={status.topics.length}
        description={t("topicsDescription")}
        flush
      >
        {status.topics.length === 0 ? (
          <SectionEmpty>{t("topicsEmpty", { count: status.projectCount })}</SectionEmpty>
        ) : (
          <SectionList>
            {status.topics.map((p) => (
              <SectionRow
                key={p.id}
                href={`/projects/${p.id}`}
                media={<SectionIcon icon={FolderKanban} />}
                title={p.name}
                trailing={
                  <>
                    {p.status !== "active" && (
                      <Badge variant="secondary" className="font-normal">
                        {statusLabel(p.status)}
                      </Badge>
                    )}
                    <Badge variant="outline" className="font-mono font-normal">
                      {t("topic", { id: String(p.topicId ?? "") })}
                    </Badge>
                  </>
                }
              />
            ))}
          </SectionList>
        )}
      </SectionCard>

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

      <SettingsNote title={t("transcriptionTitle")}>{t("transcriptionDescription")}</SettingsNote>
    </>
  );
}

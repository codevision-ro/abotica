import { Check, FolderKanban, Hash, ListOrdered, Radio, X } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionEmpty, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { SectionHeader } from "@/components/settings/section-header";
import { SettingsNote } from "@/components/settings/settings-note";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getTelegramStatus } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("telegram") };
}

/** Registered by the worker at startup (apps/worker/src/index.ts). */
const BOT_COMMANDS = "/status, /tasks, /project, /new, /stop, /resume";

function StatusRow({ label, ok, children }: { label: string; ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full [&_svg]:size-3",
            ok ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {ok ? <Check strokeWidth={3} /> : <X strokeWidth={3} />}
        </span>
        <span className="truncate font-mono text-xs font-medium">{label}</span>
      </div>
      <div className="min-w-0 pl-7.5 text-sm text-muted-foreground sm:pl-0 sm:text-right">{children}</div>
    </li>
  );
}

export default async function TelegramPage() {
  const [status, t] = await Promise.all([getTelegramStatus(), getTranslations("settings.telegram")]);
  const mono = (chunks: React.ReactNode) => <span className="font-mono text-[0.9em]">{chunks}</span>;
  const statusLabel = (value: string) => {
    const key = `projectStatus.${value}` as Parameters<typeof t>[0];
    return t.has(key) ? t(key) : value;
  };
  const notifyTarget = status.notifyChatId ?? status.allowedUserIds[0] ?? null;
  const ready = status.tokenSet && status.allowedUserIds.length > 0;
  const steps = [
    t.rich("step1", { mono }),
    t.rich("step2", { mono, commands: BOT_COMMANDS }),
    t.rich("step3", { mono }),
    t.rich("step4", { mono }),
    t.rich("step5", { mono }),
  ];

  return (
    <>
      <SectionHeader title={t("title")} description={t("description")} />
      <SectionCard
        icon={Radio}
        title={t("statusTitle")}
        description={t("statusDescription")}
        action={
          ready ? (
            <Badge className="bg-success/10 font-normal text-success">
              <span aria-hidden className="size-1.5 rounded-full bg-current" /> {t("ready")}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {t("incomplete")}
            </Badge>
          )
        }
        flush
      >
        <SectionList>
          <StatusRow label="TELEGRAM_BOT_TOKEN" ok={status.tokenSet}>
            {status.tokenSet ? t("tokenSet") : t("tokenMissing")}
          </StatusRow>
          <StatusRow label="TELEGRAM_ALLOWED_USER_IDS" ok={status.allowedUserIds.length > 0}>
            {status.allowedUserIds.length ? (
              <span className="inline-flex flex-wrap gap-1 sm:justify-end">
                {status.allowedUserIds.map((id) => (
                  <Badge key={id} variant="secondary" className="font-mono font-normal">
                    {id}
                  </Badge>
                ))}
              </span>
            ) : (
              t("noUsers")
            )}
          </StatusRow>
          <StatusRow label="TELEGRAM_NOTIFY_CHAT_ID" ok={Boolean(notifyTarget)}>
            {status.notifyChatId ? (
              <Badge variant="secondary" className="font-mono font-normal">
                {status.notifyChatId}
              </Badge>
            ) : notifyTarget ? (
              t.rich("notifyFallback", { target: notifyTarget, mono })
            ) : (
              t("notifyNone")
            )}
          </StatusRow>
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

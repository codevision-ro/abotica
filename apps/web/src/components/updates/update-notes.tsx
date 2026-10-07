import type { ReleaseInfo } from "@abotica/core";
import { ExternalLink, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { SectionCard } from "@/components/app/section-card";
import { ChatMarkdown } from "@/components/chat/chat-parts";
import { Button } from "@/components/ui/button";

/** The newer release's notes from GitHub, in a scrollable block, with a link to the release page. */
export function UpdateNotes({ release }: { release: ReleaseInfo }) {
  const t = useTranslations("settings.updates");
  const notes = release.notes.trim();
  return (
    <SectionCard
      icon={Sparkles}
      title={t("notesTitle", { version: `v${release.version}` })}
      description={t("notesDescription")}
      action={
        <Button variant="outline" size="sm" asChild>
          <a href={release.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            <span className="max-sm:sr-only">{t("releasePage")}</span>
          </a>
        </Button>
      }
    >
      {notes ? (
        <div className="max-h-96 overflow-y-auto overscroll-contain rounded-xl border border-border/70 bg-background/60 px-4 py-3 dark:bg-input/10">
          <ChatMarkdown className="text-sm leading-6 [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-base [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h3]:mt-4 [&_h3]:text-sm">
            {notes}
          </ChatMarkdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("notesEmpty")}</p>
      )}
    </SectionCard>
  );
}

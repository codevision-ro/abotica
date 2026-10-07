import { ArrowLeft, Eye } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PageBody } from "@/components/app/page-header";
import { sectionCardClass } from "@/components/app/section-card";
import { ChannelBadge } from "@/components/memory/conversation-table";
import { PanelEmpty } from "@/components/memory/memory-panel";
import { MessageTranscript } from "@/components/memory/message-transcript";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";
import { getConversationTranscript } from "@/server/queries/memory";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("memory");
  return { title: t("meta.transcriptTitle") };
}

export default async function ConversationTranscriptPage(props: PageProps<"/memory/conversations/[id]">) {
  const [{ id }, sp] = await Promise.all([props.params, props.searchParams]);
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  const data = await getConversationTranscript(id);
  if (!data) notFound();
  const { conversation, messages } = data;
  const [t, f] = await Promise.all([getTranslations("memory.conversations"), getFormat()]);

  return (
    <PageBody className="max-w-4xl">
      <Button variant="ghost" size="sm" asChild className="-ml-2 w-fit text-muted-foreground">
        <Link href={`/memory?tab=conversations${page > 1 ? `&page=${page}` : ""}`}>
          <ArrowLeft /> {t("back")}
        </Link>
      </Button>
      <header className="flex min-w-0 items-center gap-4">
        <AgentAvatar avatar={conversation.agentAvatar} size="xl" />
        <div className="min-w-0 flex-1 space-y-1">
          <h1
            title={conversation.title}
            className="line-clamp-2 text-2xl font-semibold tracking-tight wrap-anywhere sm:line-clamp-1"
          >
            {conversation.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="max-w-full truncate font-medium text-foreground/80">{conversation.agentName}</span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(conversation.createdAt).toISOString()}>
              {t("started", { date: f.dateTime(conversation.createdAt) })}
            </time>
            <ChannelBadge channel={conversation.channel} />
            <span className="inline-flex items-center gap-1 text-xs">
              <Eye className="size-3.5" aria-hidden /> {t("readOnly")}
            </span>
          </div>
        </div>
      </header>
      {messages.length ? (
        <MessageTranscript messages={messages} agent={{ name: conversation.agentName, avatar: conversation.agentAvatar }} />
      ) : (
        <div className={sectionCardClass}>
          <PanelEmpty>{t("noMessages")}</PanelEmpty>
        </div>
      )}
    </PageBody>
  );
}

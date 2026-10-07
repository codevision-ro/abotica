"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import type { UIMessage } from "ai";
import { Activity, CalendarDays, FlaskConical, FolderKanban, OctagonAlert, Send } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ChatModelState } from "@/server/queries/chat";
import { ChatComposer } from "./chat-composer";
import { ChatMessageList } from "./chat-message-list";
import { ConversationListTrigger } from "./conversation-list";
import { ChatModelPicker, OverrideDot, useChatModel } from "./chat-model-picker";
import { CHAT_COLUMN } from "./chat-parts";
import { useConversationRun } from "./use-conversation-run";

type Props = {
  conversationId: string;
  channel: "web" | "telegram" | "internal";
  agent: { name: string; avatar: AgentAvatarValue; role: string };
  /** The project the conversation works in; null for a global one. */
  project: { id: string; name: string } | null;
  /** Set when the conversation is a skill test: the agent has this skill here, assigned or not. */
  testSkill: { id: string; name: string } | null;
  /** Agent model, this conversation's override and the models it can switch to. */
  modelState: ChatModelState;
  initialMessages: UIMessage[];
  /** Message id to ISO creation time, for messages loaded from the database. */
  timestamps: Record<string, string>;
  /** File id to size in bytes, for the conversation's files. */
  fileSizes: Record<string, number>;
  /** An answer to a new message is running: stream it. */
  resume: boolean;
  /** A run continuing the last answer is running: wait for it, it cannot be streamed. */
  waiting: boolean;
};

const SUGGESTIONS = [
  { icon: Activity, key: "status" },
  { icon: CalendarDays, key: "plan" },
  { icon: OctagonAlert, key: "blocked" },
] as const;

export function ChatView({
  conversationId,
  channel,
  agent,
  project,
  testSkill,
  modelState,
  initialMessages,
  timestamps,
  fileSizes,
  resume,
  waiting,
}: Props) {
  const t = useTranslations("chat");
  const chatModel = useChatModel(conversationId, modelState);
  const { effective } = chatModel;
  const modelId = effective.ref ? `${effective.ref.provider}/${effective.ref.model}` : t("model.noAgentModel");
  const modelTitle = effective.overridden ? `${modelId} (${t("model.overridden")})` : modelId;
  const run = useConversationRun({ conversationId, initialMessages, fileSizes, resume, waiting });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 px-3 md:px-6">
        <ConversationListTrigger />
        <AgentAvatar avatar={agent.avatar} size="lg" className="size-9 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-snug font-semibold md:text-base" title={agent.name}>
            {agent.name}
          </div>
          {agent.role && (
            <div className="truncate text-xs text-muted-foreground" title={agent.role}>
              {agent.role}
            </div>
          )}
        </div>
        {project && (
          <Badge variant="outline" className="max-w-40 min-w-0 shrink gap-1 font-normal sm:max-w-56" asChild>
            <Link href={`/projects/${project.id}`} title={t("projectBadge", { project: project.name })}>
              <FolderKanban className="text-primary" aria-hidden />
              <span className="truncate">{project.name}</span>
            </Link>
          </Badge>
        )}
        {channel === "telegram" && (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Send className="size-3" /> Telegram
          </Badge>
        )}
        {channel === "web" ? (
          <ChatModelPicker
            state={modelState}
            selection={chatModel.selection}
            effective={effective}
            onChange={chatModel.save}
            busy={run.busy}
          />
        ) : (
          <Badge
            variant="outline"
            className={cn(
              "hidden max-w-72 shrink gap-1.5 font-mono text-[11px] font-normal text-muted-foreground sm:inline-flex",
              effective.overridden && "border-primary/30",
            )}
            title={modelTitle}
          >
            {effective.overridden && <OverrideDot />}
            <span className="truncate">{modelId}</span>
            {effective.overridden && <span className="sr-only">({t("model.overridden")})</span>}
          </Badge>
        )}
      </header>
      {testSkill && (
        <div
          className="flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground md:px-6"
          title={t("skillTest.hint")}
        >
          <FlaskConical className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 truncate">
            {t.rich("skillTest.label", {
              name: testSkill.name,
              link: (chunks) => (
                <Link
                  href={`/skills/${testSkill.id}`}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </span>
        </div>
      )}

      {run.messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className={cn(CHAT_COLUMN, "my-auto flex flex-col items-center py-10 text-center")}>
            <AgentAvatar avatar={agent.avatar} size="2xl" />
            <h2 className="mt-5 line-clamp-2 max-w-xl text-xl font-semibold tracking-tight wrap-anywhere">
              {t("empty.title", { name: agent.name })}
            </h2>
            <p className="mt-1.5 max-w-md text-sm text-pretty text-muted-foreground">{t("empty.description")}</p>
            <div className="mt-8 grid w-full max-w-2xl gap-2.5 sm:grid-cols-3 sm:gap-3">
              {SUGGESTIONS.map(({ icon: Icon, key }) => {
                const text = t(`suggestions.${key}`);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void run.sendMessage({ text })}
                    className="group flex items-center gap-3 rounded-2xl border border-border/70 bg-card/70 p-3.5 text-left text-sm shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition-colors hover:border-primary/30 hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:flex-col sm:items-start sm:p-4 dark:bg-card/40 dark:hover:bg-card"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
                      <Icon className="size-4" />
                    </span>
                    <span className="leading-snug text-foreground/90 group-hover:text-foreground">{text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <ChatMessageList
          messages={run.messages}
          timestamps={timestamps}
          fileSizes={run.fileSizes}
          agentAvatar={agent.avatar}
          answering={run.answering}
          thinking={run.thinking}
          waiting={run.waiting}
          error={run.error}
          onDecide={run.decide}
        />
      )}

      <ChatComposer
        agentName={agent.name}
        busy={run.busy}
        status={run.status}
        onStop={run.stop}
        queue={run.queue}
        onSubmit={run.submit}
        onUnqueue={run.unqueue}
      />
    </div>
  );
}

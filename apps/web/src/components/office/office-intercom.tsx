"use client";

import type { OfficeAgent } from "@abotica/core/office";
import type { UIMessage } from "ai";
import { FolderKanbanIcon, ListTodoIcon, MessageSquareIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { messageText } from "@/components/chat/chat-parts";
import { useConversationRun } from "@/components/chat/use-conversation-run";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { loadConversationMessages, startConversation } from "@/server/actions/chat";

/** Something in the office the message is about: picked by clicking it while the intercom is open. */
export type IntercomRef =
  | { kind: "agent"; id: string; name: string; avatar: OfficeAgent["avatar"] }
  | { kind: "task"; id: string; name: string }
  | { kind: "project"; id: string; name: string };

/** What the super agent is saying on the phone, for the scene. */
export type IntercomCall = { talking: boolean; text: string | null };

const MAX_REFS = 4;

/** Adds a reference once, newest last, keeping the last few. */
export const addRef = (refs: IntercomRef[], ref: IntercomRef) =>
  [...refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id)), ref].slice(-MAX_REFS);

type History = {
  messages: UIMessage[];
  timestamps: Record<string, string>;
  fileSizes: Record<string, number>;
  active: boolean;
};

/**
 * Talking to the super agent without leaving the office: a bar at the bottom that opens into the latest
 * conversation with it (the same one the Chat page shows). While it is open, clicking someone or something
 * in the office attaches it to the message, with its id, so the super agent knows exactly what is meant.
 */
export function OfficeIntercom({
  superAgent,
  conversationId: initialId,
  open,
  onOpenChange,
  refs,
  onRefsChange,
  needsYou,
  onCall,
}: {
  superAgent: OfficeAgent | null;
  /** The latest web conversation with the super agent; null until there is one. */
  conversationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refs: IntercomRef[];
  onRefsChange: (refs: IntercomRef[]) => void;
  /** How many in the office wait for the user. */
  needsYou: number;
  onCall: (call: IntercomCall) => void;
}) {
  const t = useTranslations("office.intercom");
  const [conversationId, setConversationId] = useState(initialId);
  const [history, setHistory] = useState<History | null>(null);
  const [loading, startLoading] = useTransition();

  // Opened: load the conversation (or start the first one) once.
  useEffect(() => {
    if (!open || history) return;
    startLoading(async () => {
      let id = conversationId;
      if (!id) {
        const started = await startConversation({});
        if (!started.ok) return void toast.error(started.error);
        id = started.data.id;
        setConversationId(id);
      }
      const res = await loadConversationMessages({ id });
      if (!res.ok) return void toast.error(res.error);
      setHistory(res.data);
    });
  }, [open, history, conversationId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!superAgent) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        className="pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-full border border-border/70 bg-card/90 py-1.5 pr-4 pl-1.5 text-left text-sm shadow-md backdrop-blur-md outline-none hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-card/80"
      >
        <AgentAvatar avatar={superAgent.avatar} size="md" className="rounded-full" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{t("placeholder", { name: superAgent.name })}</span>
        {needsYou > 0 && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-warning">
            <span className="size-1.5 animate-pulse rounded-full bg-warning" />
            {t("needsYou", { count: needsYou })}
          </span>
        )}
        <MessageSquareIcon className="size-4 shrink-0 text-primary" aria-hidden />
      </button>
    );
  }

  return (
    <section
      aria-label={t("title", { name: superAgent.name })}
      className="pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl"
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/70 px-3 py-2">
        <AgentAvatar avatar={superAgent.avatar} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{superAgent.name}</div>
          {superAgent.role && <div className="truncate text-xs text-muted-foreground">{superAgent.role}</div>}
        </div>
        {conversationId && (
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href={`/chat/${conversationId}`} title={t("openInChat")} aria-label={t("openInChat")}>
              <SquareArrowOutUpRightIcon />
            </Link>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenChange(false)}
          title={t("close")}
          aria-label={t("close")}
        >
          <XIcon />
        </Button>
      </header>
      {history && conversationId && !loading ? (
        <IntercomChat
          key={conversationId}
          conversationId={conversationId}
          history={history}
          superAgent={superAgent}
          refs={refs}
          onRefsChange={onRefsChange}
          onCall={onCall}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
    </section>
  );
}

function IntercomChat({
  conversationId,
  history,
  superAgent,
  refs,
  onRefsChange,
  onCall,
}: {
  conversationId: string;
  history: History;
  superAgent: OfficeAgent;
  refs: IntercomRef[];
  onRefsChange: (refs: IntercomRef[]) => void;
  onCall: (call: IntercomCall) => void;
}) {
  const t = useTranslations("office.intercom");
  const continues = history.messages.at(-1)?.role === "assistant";
  const run = useConversationRun({
    conversationId,
    initialMessages: history.messages,
    fileSizes: history.fileSizes,
    resume: history.active && !continues,
    waiting: history.active && continues,
  });

  // The scene shows the super agent on the phone while it answers, saying the start of its answer.
  const last = run.messages.at(-1);
  const said = last?.role === "assistant" ? messageText(last).replace(/\s+/g, " ").trim() : "";
  const text = said ? (said.length > 140 ? `${said.slice(0, 139)}...` : said) : null;
  useEffect(() => {
    onCall({ talking: run.answering, text });
  }, [run.answering, text, onCall]);
  useEffect(() => () => onCall({ talking: false, text: null }), [onCall]);

  /** The references go out as a last line of the message, with their ids, in the user's language. */
  function submit(message: { text: string; files: Parameters<typeof run.submit>[0]["files"] }) {
    const about = refs.map((r) => t(`ref.${r.kind}`, { name: r.name, id: r.id })).join("; ");
    const text = about ? `${message.text.trim()}\n\n${t("about", { items: about })}` : message.text;
    run.submit({ ...message, text });
    onRefsChange([]);
  }

  return (
    <>
      {run.messages.length === 0 ? (
        <p className="m-auto px-6 text-center text-sm text-muted-foreground">{t("empty", { name: superAgent.name })}</p>
      ) : (
        <ChatMessageList
          messages={run.messages}
          timestamps={history.timestamps}
          fileSizes={run.fileSizes}
          agentAvatar={superAgent.avatar}
          sent={run.sent}
          answering={run.answering}
          thinking={run.thinking}
          waiting={run.waiting}
          error={run.error}
          onDecide={run.decide}
        />
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-1 md:px-8">
        {refs.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("pickHint")}</span>
        ) : (
          refs.map((r) => (
            <span
              key={`${r.kind}:${r.id}`}
              className="flex max-w-56 items-center gap-1 rounded-full border border-primary/25 bg-primary/8 py-0.5 pr-1 pl-1.5 text-xs dark:bg-primary/15"
            >
              {r.kind === "agent" ? (
                <AgentAvatar avatar={r.avatar} size="xs" className="size-4 rounded-full [&_svg]:size-2.5!" />
              ) : r.kind === "task" ? (
                <ListTodoIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
              ) : (
                <FolderKanbanIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
              )}
              <span className="truncate">{r.name}</span>
              <button
                type="button"
                onClick={() => onRefsChange(refs.filter((x) => x !== r))}
                aria-label={t("removeRef", { name: r.name })}
                className={cn("rounded-full p-0.5 text-muted-foreground hover:text-foreground")}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))
        )}
      </div>
      <ChatComposer agentName={superAgent.name} busy={run.busy} status={run.status} onStop={run.stop} onSubmit={submit} />
    </>
  );
}

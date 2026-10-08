"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { isCompaction } from "@abotica/core/compaction-record";
import { isDelegationReport } from "@abotica/core/delegation-report";
import { fileIdFromUrl } from "@abotica/core/file-types";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { CircleAlert, CopyIcon, FileIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChatFileCard, sharedFile } from "./chat-file-card";
import { CHAT_COLUMN, ChatApproval, ChatMarkdown, ChatToolCall, ChatToolGroup, MessageTime } from "./chat-parts";
import { CompactionDivider } from "./compaction-divider";
import { DelegationNotice } from "./delegation-notice";
import { UntrustedText } from "./untrusted-text";

type Part = UIMessage["parts"][number];

type Props = {
  messages: UIMessage[];
  /** Message id to ISO creation time, for messages loaded from the database. */
  timestamps: Record<string, string>;
  /** File id to size in bytes. */
  fileSizes: Record<string, number>;
  agentAvatar: AgentAvatarValue;
  answering: boolean;
  thinking: boolean;
  waiting: boolean;
  error: Error | undefined;
  onDecide: (approvalId: string, approved: boolean) => Promise<void>;
};

export function ChatMessageList({
  messages,
  timestamps,
  fileSizes,
  agentAvatar,
  answering,
  thinking,
  waiting,
  error,
  onDecide,
}: Props) {
  const t = useTranslations("chat");
  const tCommon = useTranslations("common");
  const last = messages.at(-1);

  const thinkingLine = (
    <Shimmer className="text-sm" duration={1.5}>
      {t("thinking")}
    </Shimmer>
  );

  function renderAssistantParts(message: UIMessage) {
    // Consecutive tool calls are stacked tightly, apart from the text around them.
    const blocks: { key: string; tools: boolean; parts: { part: Part; key: string }[] }[] = [];
    message.parts.forEach((part, i) => {
      if (part.type === "reasoning" || part.type === "step-start") return;
      const tools = isToolUIPart(part);
      const prev = blocks.at(-1);
      const entry = { part, key: `${message.id}-${i}` };
      if (prev && prev.tools && tools) prev.parts.push(entry);
      else blocks.push({ key: entry.key, tools, parts: [entry] });
    });

    return blocks.map((block) =>
      block.tools ? (
        <ChatToolGroup key={block.key}>
          {block.parts.map(({ part, key }) => {
            if (!isToolUIPart(part)) return null;
            const name = getToolName(part);
            const file = name === "file_share" && part.state === "output-available" ? sharedFile(part.output) : null;
            return (
              <ChatToolCall key={key} part={part} name={name}>
                <ChatApproval part={part} name={name} onDecide={onDecide} />
                {file && <ChatFileCard file={file} />}
              </ChatToolCall>
            );
          })}
        </ChatToolGroup>
      ) : (
        block.parts.map(({ part, key }) => <PartView key={key} part={part} fileSizes={fileSizes} />)
      ),
    );
  }

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className={cn(CHAT_COLUMN, "gap-8 pt-6 pb-10 md:pt-8")}>
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          const streaming = answering && isLast;
          // Delivered to the agent as a user message, or to the user only (withheld) as a system one.
          if (isDelegationReport(message.metadata)) {
            return <DelegationNotice key={message.id} report={message.metadata} date={timestamps[message.id]} />;
          }
          if (isCompaction(message.metadata)) {
            return <CompactionDivider key={message.id} compaction={message.metadata} date={timestamps[message.id]} />;
          }
          if (message.role === "user") {
            const files = message.parts.filter((p) => p.type === "file");
            const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
            return (
              <div key={message.id} className="group flex flex-col items-end gap-1.5">
                {files.length > 0 && (
                  <div className="flex max-w-[85%] flex-wrap justify-end gap-2 sm:max-w-[75%]">
                    {files.map((part, i) => (
                      <PartView key={`${message.id}-f${i}`} part={part} fileSizes={fileSizes} />
                    ))}
                  </div>
                )}
                {text.trim() && (
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/8 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere ring-1 ring-primary/10 ring-inset sm:max-w-[75%] dark:bg-primary/15">
                    <UntrustedText text={text} />
                  </div>
                )}
                <div className="px-1 text-[11px] text-muted-foreground/80">
                  <MessageTime date={timestamps[message.id]} />
                </div>
              </div>
            );
          }
          const copyText = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
          return (
            <div key={message.id} className="group flex gap-3 md:gap-4">
              <AgentAvatar avatar={agentAvatar} size="lg" className="hidden sm:flex" />
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                {renderAssistantParts(message)}
                {streaming && thinking && thinkingLine}
                {!streaming && (
                  <div className="-mt-1 flex h-7 items-center gap-1 text-[11px] text-muted-foreground/80">
                    <MessageTime date={timestamps[message.id]} />
                    {copyText.trim() && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                        aria-label={t("message.copyReply")}
                        title={tCommon("actions.copy")}
                        onClick={() =>
                          navigator.clipboard.writeText(copyText).then(
                            () => toast.success(tCommon("actions.copied")),
                            (e: Error) => toast.error(e.message),
                          )
                        }
                      >
                        <CopyIcon />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {((thinking && last?.role !== "assistant") || waiting) && (
          <div className="flex items-center gap-3 md:gap-4">
            <AgentAvatar avatar={agentAvatar} size="lg" className="hidden sm:flex" />
            {thinkingLine}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 wrap-anywhere">{error.message}</span>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton
        className="bottom-6 shadow-md"
        aria-label={t("message.scrollToBottom")}
        title={t("message.scrollToBottom")}
      />
    </Conversation>
  );
}

function PartView({ part, fileSizes }: { part: Part; fileSizes: Record<string, number> }) {
  const t = useTranslations("chat.attachments");
  if (part.type === "text") return part.text.trim() ? <ChatMarkdown>{part.text}</ChatMarkdown> : null;
  if (part.type === "file") {
    const id = fileIdFromUrl(part.url);
    if (id) {
      const file = { id, name: part.filename ?? t("fallbackName"), mimeType: part.mediaType, size: fileSizes[id] };
      return <ChatFileCard file={file} className="m-0 w-80 max-w-full" />;
    }
    // A file part that is not stored (e.g. an image a model returned inline) carries its bytes in the URL.
    return part.mediaType.startsWith("image/") ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={part.url}
        alt={part.filename ?? ""}
        className="max-h-72 w-auto max-w-full rounded-xl border object-contain"
      />
    ) : (
      <span className="inline-flex h-10 max-w-full min-w-0 items-center gap-2.5 rounded-xl border border-border/70 bg-card/70 pr-3.5 pl-1.5 text-sm dark:bg-card/40">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
          <FileIcon className="size-3.5" />
        </span>
        <span className="min-w-0 truncate" title={part.filename ?? part.mediaType}>
          {part.filename ?? part.mediaType}
        </span>
      </span>
    );
  }
  return null;
}

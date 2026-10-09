"use client";

import { FILE_MAX_BYTES } from "@abotica/core/limits";
import type { ChatStatus } from "ai";
import { FileIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { type UploadedFile, uploadFiles } from "@/lib/upload-files";
import { cn } from "@/lib/utils";
import { CHAT_COLUMN } from "./chat-parts";

const FILE_MAX_MB = FILE_MAX_BYTES / (1024 * 1024);

const shortName = (name: string) => (name.length > 28 ? name.slice(0, 27).trimEnd() : name);

function Chip({
  icon,
  children,
  onRemove,
  label,
  disabled,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onRemove: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border bg-muted/50 pr-1 pl-2 text-xs">
      {icon}
      <span className="max-w-56 min-w-0 truncate">{children}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label={label}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

/** Focus the composer, except on touch screens where that would pop up the keyboard. */
const focusComposer = (el: HTMLTextAreaElement | null) => {
  if (el && window.matchMedia("(pointer: fine)").matches) el.focus();
};

function AttachmentChips({ onRemoved, locked }: { onRemoved: () => void; locked: boolean }) {
  const attachments = usePromptInputAttachments();
  const t = useTranslations("chat.attachments");
  if (!attachments.files.length) return null;
  return (
    <div className="flex w-full flex-wrap gap-1.5 px-3 pt-3">
      {attachments.files.map((file) => (
        <Chip
          key={file.id}
          icon={<FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}
          onRemove={() => {
            attachments.remove(file.id);
            onRemoved();
          }}
          label={t("remove")}
          disabled={locked}
        >
          {file.filename ?? t("fallbackName")}
        </Chip>
      ))}
    </div>
  );
}

const SUBMIT = "size-9 rounded-full disabled:opacity-35";

/**
 * Send button: attachments alone are enough to send; while the agent works it sends (the run reads the
 * message at its next step) instead of stopping; while files upload it waits.
 */
function ComposerSubmit({
  busy,
  uploading,
  hasText,
  status,
  onStop,
  steerTitle,
}: {
  busy: boolean;
  uploading: boolean;
  hasText: boolean;
  status: ChatStatus;
  onStop: () => void;
  steerTitle: string;
}) {
  const { files } = usePromptInputAttachments();
  const hasContent = hasText || files.length > 0;
  if (uploading) return <PromptInputSubmit status="submitted" disabled className={SUBMIT} />;
  return busy && hasContent ? (
    <PromptInputSubmit status="ready" disabled={false} title={steerTitle} className={SUBMIT} />
  ) : (
    <PromptInputSubmit status={status} onStop={onStop} disabled={!busy && !hasContent} className={SUBMIT} />
  );
}

type Props = {
  agentName: string;
  busy: boolean;
  status: ChatStatus;
  onStop: () => void;
  /** Files are uploaded already: the message carries references to them. */
  onSubmit: (message: { text: string; files: UploadedFile[] }) => void;
};

export function ChatComposer({ agentName, busy, status, onStop, onSubmit }: Props) {
  const t = useTranslations("chat");
  const tFiles = useTranslations("files");
  const [input, setInput] = useState("");
  /** Share of the files uploaded so far, while sending; null otherwise. */
  const [upload, setUpload] = useState<number | null>(null);
  /** Attachments already stored, by their local URL: retrying after a failed upload sends only the rest. */
  const storedRef = useRef(new Map<string, UploadedFile>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => focusComposer(textareaRef.current), []);

  /**
   * Uploads the attachments, then sends the message with references to them. A failed
   * upload throws, which keeps the text and the attachments in the composer for another try.
   */
  async function send(message: PromptInputMessage) {
    // Throwing (not returning) keeps the composer as it is: PromptInput clears it after a successful send.
    if (upload !== null) throw new Error("Upload in progress");
    if (!message.text.trim() && !message.files.length) return;
    const stored = storedRef.current;
    const missing = message.files.filter((f) => !stored.has(f.url));
    if (missing.length) {
      setUpload(0);
      try {
        const blobs = await Promise.all(
          missing.map(async (f) => ({
            data: await fetch(f.url).then((r) => r.blob()),
            name: f.filename ?? t("attachments.fallbackName"),
          })),
        );
        await uploadFiles(blobs, {
          onProgress: setUpload,
          fallbackError: tFiles("errors.uploadFailed"),
          onUploaded: (index, file) => stored.set(missing[index]!.url, file),
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : tFiles("errors.uploadFailed"));
        throw error;
      } finally {
        setUpload(null);
      }
    }
    const files = message.files.map((f) => stored.get(f.url)!);
    for (const f of message.files) stored.delete(f.url);
    onSubmit({ text: message.text, files });
    setInput("");
    focusComposer(textareaRef.current);
  }

  return (
    <div className="relative z-10 shrink-0">
      <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-linear-to-t from-background to-transparent" />
      <div className={cn(CHAT_COLUMN, "pb-3 md:pb-6")}>
        <PromptInput
          maxFileSize={FILE_MAX_BYTES}
          onFilesTooLarge={() => toast.error(t("input.errors.maxFileSize", { max: FILE_MAX_MB }))}
          className={cn(
            "[&_[data-slot=input-group]]:rounded-[1.25rem] [&_[data-slot=input-group]]:border-border [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.16)]",
            "[&_[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:border-primary/35 [&_[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-4 [&_[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-primary/8",
            "dark:[&_[data-slot=input-group]]:bg-card dark:[&_[data-slot=input-group]]:shadow-none dark:[&_[data-slot=input-group]]:has-[[data-slot=input-group-control]:focus-visible]:ring-primary/15",
          )}
          onSubmit={send}
        >
          <AttachmentChips onRemoved={() => focusComposer(textareaRef.current)} locked={upload !== null} />
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              // The text goes out with the files once they are uploaded; editing it meanwhile would be lost.
              readOnly={upload !== null}
              placeholder={t("input.placeholder", { name: shortName(agentName) })}
              className="min-h-14 px-4 pt-4 pb-1 text-base leading-6 md:text-[15px]"
            />
          </PromptInputBody>
          <PromptInputFooter className="px-2 pb-2">
            <PromptInputTools>
              <DropdownMenu>
                <PromptInputActionMenuTrigger
                  className="size-9 rounded-full text-muted-foreground hover:text-foreground"
                  aria-label={t("attachments.attach")}
                />
                <DropdownMenuContent align="start">
                  <PromptInputActionAddAttachments label={t("attachments.attachFiles")} />
                </DropdownMenuContent>
              </DropdownMenu>
              {upload !== null ? (
                <span className="tabular min-w-0 truncate text-xs text-muted-foreground" role="status">
                  {t("attachments.uploading", { percent: Math.round(upload * 100) })}
                </span>
              ) : (
                busy && <span className="min-w-0 truncate text-xs text-muted-foreground">{t("queue.steer")}</span>
              )}
            </PromptInputTools>
            <ComposerSubmit
              busy={busy}
              uploading={upload !== null}
              hasText={Boolean(input.trim())}
              status={status}
              onStop={onStop}
              steerTitle={t("queue.steer")}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

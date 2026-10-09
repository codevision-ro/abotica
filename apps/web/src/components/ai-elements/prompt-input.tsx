"use client";

import { DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatStatus, FileUIPart } from "ai";
import { ArrowUpIcon, ImageIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslations } from "next-intl";
import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
} from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type AttachmentsContext = {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  openFileDialog: () => void;
};

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  const context = useContext(LocalAttachmentsContext);
  if (!context) {
    throw new Error("usePromptInputAttachments must be used within a PromptInput");
  }
  return context;
};

export const PromptInputActionAddAttachments = ({
  label,
  ...props
}: ComponentProps<typeof DropdownMenuItem> & { label: string }) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    (e: Event) => {
      e.preventDefault();
      attachments.openFileDialog();
    },
    [attachments],
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <ImageIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  /** In bytes. */
  maxFileSize: number;
  /** All the added files exceed `maxFileSize` (when only some do, those are dropped silently). */
  onFilesTooLarge: () => void;
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

/** Takes several files at once, from the file dialog, a paste, or a drop anywhere on the page. */
export const PromptInput = ({
  className,
  maxFileSize,
  onFilesTooLarge,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const t = useTranslations("chat.input");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<(FileUIPart & { id: string })[]>([]);

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openFileDialog = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const add = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const sized = incoming.filter((f) => f.size <= maxFileSize);
      if (incoming.length > 0 && sized.length === 0) {
        onFilesTooLarge();
        return;
      }

      setFiles((prev) => [
        ...prev,
        ...sized.map((file) => ({
          filename: file.name,
          id: nanoid(),
          mediaType: file.type,
          type: "file" as const,
          url: URL.createObjectURL(file),
        })),
      ]);
    },
    [maxFileSize, onFilesTooLarge],
  );

  const remove = useCallback(
    (id: string) =>
      setFiles((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  const clear = useCallback(
    () =>
      setFiles((prev) => {
        for (const file of prev) {
          if (file.url) {
            URL.revokeObjectURL(file.url);
          }
        }
        return [];
      }),
    [],
  );

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add]);

  useEffect(
    () => () => {
      for (const f of filesRef.current) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
    },
    [],
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        add(event.currentTarget.files);
      }
      // Reset input value to allow selecting files that were previously removed
      event.currentTarget.value = "";
    },
    [add],
  );

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({ add, files, openFileDialog, remove }),
    [files, add, remove, openFileDialog],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();

      const form = event.currentTarget;
      const text = (new FormData(form).get("message") as string) || "";

      // Files keep their blob: URLs: the caller uploads them and sends references, never the bytes.
      // The inputs are cleared only once onSubmit succeeds, so a failed upload keeps text and files.
      const submitted: FileUIPart[] = files.map(({ id: _id, ...item }) => item);
      try {
        await onSubmit({ files: submitted, text }, event);
        form.reset();
        clear();
      } catch {
        // Don't clear on error - user may want to retry
      }
    },
    [files, onSubmit, clear],
  );

  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <input
        aria-label={t("uploadFiles")}
        className="hidden"
        multiple
        onChange={handleChange}
        ref={inputRef}
        title={t("uploadFiles")}
        type="file"
      />
      <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </LocalAttachmentsContext.Provider>
  );
};

export const PromptInputBody = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("contents", className)} {...props} />
);

export const PromptInputTextarea = ({
  onKeyDown,
  className,
  ...props
}: ComponentProps<typeof InputGroupTextarea>) => {
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // Call the external onKeyDown handler first
      onKeyDown?.(e);

      // If the external handler prevented default, don't run internal logic
      if (e.defaultPrevented) {
        return;
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return;
        }
        if (e.shiftKey) {
          return;
        }
        // Touch keyboards have no Shift+Enter: there Enter adds a new line and the send button sends.
        if (window.matchMedia("(pointer: coarse)").matches) {
          return;
        }
        e.preventDefault();

        // Check if the submit button is disabled before submitting
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (submitButton?.disabled) {
          return;
        }

        form?.requestSubmit();
      }

      // Remove last attachment when Backspace is pressed and textarea is empty
      if (e.key === "Backspace" && e.currentTarget.value === "" && attachments.files.length > 0) {
        e.preventDefault();
        const lastAttachment = attachments.files.at(-1);
        if (lastAttachment) {
          attachments.remove(lastAttachment.id);
        }
      }
    },
    [onKeyDown, isComposing, attachments],
  );

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items;

      if (!items) {
        return;
      }

      const files: File[] = [];

      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        attachments.add(files);
      }
    },
    [attachments],
  );

  const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
  const handleCompositionStart = useCallback(() => setIsComposing(true), []);

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={handleCompositionEnd}
      onCompositionStart={handleCompositionStart}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      {...props}
    />
  );
};

export const PromptInputFooter = ({ className, ...props }: Omit<ComponentProps<typeof InputGroupAddon>, "align">) => (
  <InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />
);

export const PromptInputTools = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />
);

export const PromptInputActionMenuTrigger = (props: ComponentProps<typeof InputGroupButton>) => (
  <DropdownMenuTrigger asChild>
    <InputGroupButton size="icon-sm" type="button" variant="ghost" {...props}>
      <PlusIcon className="size-4" />
    </InputGroupButton>
  </DropdownMenuTrigger>
);

export const PromptInputSubmit = ({
  status,
  onStop,
  ...props
}: ComponentProps<typeof InputGroupButton> & {
  status: ChatStatus;
  onStop?: () => void;
}) => {
  const t = useTranslations("chat.input");
  const isGenerating = status === "submitted" || status === "streaming";

  let Icon = <ArrowUpIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Spinner />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-3 fill-current" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault();
        onStop();
      }
    },
    [isGenerating, onStop],
  );

  return (
    <InputGroupButton
      aria-label={isGenerating ? t("stop") : t("send")}
      onClick={handleClick}
      size="icon-sm"
      type={isGenerating && onStop ? "button" : "submit"}
      variant="default"
      {...props}
    >
      {Icon}
    </InputGroupButton>
  );
};

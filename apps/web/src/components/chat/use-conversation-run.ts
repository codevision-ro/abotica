"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLiveEvent } from "@/components/app/live-updates";
import type { UploadedFile } from "@/lib/upload-files";
import { decideApproval } from "@/server/actions/approvals";
import { loadConversationMessages } from "@/server/actions/chat";
import { stopConversation } from "@/server/actions/runs";

/** Files are references to stored uploads (`/api/files/<id>`), never their bytes. */
export type QueuedMessage = { id: number; text: string; files: FileUIPart[] };

const toFilePart = (file: UploadedFile): FileUIPart => ({
  type: "file",
  url: file.url,
  mediaType: file.mediaType,
  filename: file.name,
});

type Options = {
  conversationId: string;
  initialMessages: UIMessage[];
  /** File id to size in bytes, for the conversation's files. */
  fileSizes: Record<string, number>;
  /** An answer to a new message is running: stream it. */
  resume: boolean;
  /** A run continuing the last answer is running: wait for it, it cannot be streamed. */
  waiting: boolean;
};

/**
 * Keeps an open chat in sync with the conversation's runs: streams its own answers, queues
 * messages written meanwhile, waits for continuations and picks up runs started elsewhere.
 */
export function useConversationRun({
  conversationId,
  initialMessages,
  fileSizes: initialFileSizes,
  resume,
  waiting: initialWaiting,
}: Options) {
  // Resuming matters on mount only; a later refresh (e.g. after picking a model) must not resume a live stream again.
  const [resumeOnMount] = useState(resume);
  // Messages written while the agent is still answering; sent together once it is done.
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  // File parts carry no size; the cards look it up here.
  const [fileSizes, setFileSizes] = useState(initialFileSizes);
  const updateQueue = (next: QueuedMessage[]) => {
    queueRef.current = next;
    setQueue(next);
  };
  const flushRef = useRef<() => void>(() => {});
  const { messages, setMessages, sendMessage, status, stop, addToolApprovalResponse, resumeStream, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    resume: resumeOnMount,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ id, messages }) => ({ body: { conversationId: id, message: messages.at(-1) } }),
    }),
    onError: (e) => toast.error(e.message),
    // When the answer ends, send everything queued meanwhile as one message. After Stop the run is
    // still winding down on the server; the queue goes out once it has ended (`settle`).
    onFinish: ({ isAbort }) => {
      if (!isAbort) setTimeout(() => flushRef.current(), 0);
    },
  });

  useEffect(() => {
    flushRef.current = () => {
      const batch = queueRef.current;
      if (!batch.length) return;
      updateQueue([]);
      void sendMessage({
        text: batch
          .map((m) => m.text)
          .filter(Boolean)
          .join("\n\n"),
        files: batch.flatMap((m) => m.files),
      });
    };
  });

  // A run that continues an earlier answer (after an approval) cannot be streamed into it:
  // the chat waits for it to finish and then shows the saved answer.
  const [waiting, setWaiting] = useState(initialWaiting);
  const answering = status === "submitted" || status === "streaming";
  const busy = answering || waiting;
  const last = messages.at(-1);
  // Show a quiet "thinking" line until the answer starts, instead of the model's reasoning.
  const thinking = answering && (last?.role !== "assistant" || !last.parts.some((p) => p.type === "text" && p.text.trim()));

  // Runs this chat starts itself are already handled; only ones started elsewhere are picked up live.
  const busyRef = useRef(busy);
  const startingRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  });

  /** Loads the saved messages; returns whether a run is still active in the conversation. */
  async function refresh(): Promise<{ active: boolean; lastRole?: string } | null> {
    const res = await loadConversationMessages({ id: conversationId });
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    setMessages(res.data.messages);
    setFileSizes((sizes) => ({ ...sizes, ...res.data.fileSizes }));
    return { active: res.data.active, lastRole: res.data.messages.at(-1)?.role };
  }

  async function settle() {
    const state = await refresh();
    if (state && !state.active) {
      setWaiting(false);
      // Messages written while waiting go out now, like after a streamed answer.
      setTimeout(() => flushRef.current(), 0);
    }
  }

  // Live events are the fast path; polling covers a missed event.
  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  });
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void settleRef.current(), 4_000);
    return () => clearInterval(timer);
  }, [waiting]);

  async function decide(approvalId: string, approved: boolean) {
    startingRef.current = true;
    try {
      const res = await decideApproval({ approvalId, approved });
      if (!res.ok) return void toast.error(res.error);
      await addToolApprovalResponse({ id: approvalId, approved });
      if (res.data.continued) setWaiting(true);
    } finally {
      startingRef.current = false;
    }
  }

  useLiveEvent((event) => {
    // A notice added outside a run (a report delivered to the user). Not while answering: replacing the
    // messages would cut the stream; the notice then shows with the next load of the conversation.
    if (event.type === "conversation.updated") {
      if (event.conversationId === conversationId && !busyRef.current && !startingRef.current) void refresh();
      return;
    }
    if (event.type !== "run.updated" || event.conversationId !== conversationId) return;
    if (waiting) {
      if (event.status !== "queued" && event.status !== "running") void settle();
      return;
    }
    // A run started elsewhere (Telegram, an approval, delegated work reporting back).
    if (event.status !== "queued" || busyRef.current || startingRef.current) return;
    startingRef.current = true;
    void (async () => {
      try {
        const state = await refresh();
        if (!state?.active) return;
        // A new message gets a fresh answer, which streams; a continuation is waited for.
        if (state.lastRole === "user") await resumeStream();
        else setWaiting(true);
      } finally {
        startingRef.current = false;
      }
    })();
  });

  /** Sends a message with its uploaded files, or queues it while the agent is still answering. */
  function submit(message: { text: string; files: UploadedFile[] }) {
    if (message.files.length) {
      setFileSizes((sizes) => ({ ...sizes, ...Object.fromEntries(message.files.map((f) => [f.id, f.size])) }));
    }
    const files = message.files.map(toFilePart);
    if (busy) updateQueue([...queueRef.current, { id: Date.now(), text: message.text.trim(), files }]);
    else void sendMessage({ text: message.text, files });
  }

  const unqueue = (id: number) => updateQueue(queueRef.current.filter((x) => x.id !== id));

  /**
   * Stop: ends the run on the server (its tools and processes too), not only the stream here. The
   * chat then waits for the run to end and shows the answer as saved, with stopped tool calls.
   */
  async function stopAnswer() {
    void stop();
    setWaiting(true);
    const res = await stopConversation({ id: conversationId });
    if (!res.ok) toast.error(res.error);
    // Nothing was running any more: no event will come, so load the final state now.
    if (!res.ok || res.data.stopped === 0) void settle();
  }

  return {
    messages,
    sendMessage,
    status,
    stop: stopAnswer,
    error,
    answering,
    busy,
    waiting,
    thinking,
    queue,
    submit,
    unqueue,
    decide,
    fileSizes,
  };
}

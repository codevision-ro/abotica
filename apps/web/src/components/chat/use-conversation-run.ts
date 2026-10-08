"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, generateId, type UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLiveEvent } from "@/components/app/live-updates";
import type { UploadedFile } from "@/lib/upload-files";
import { decideApproval } from "@/server/actions/approvals";
import { loadConversationMessages } from "@/server/actions/chat";
import { stopConversation } from "@/server/actions/runs";

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
 * Keeps an open chat in sync with the conversation's runs: streams its own answers, sends messages
 * written meanwhile right away (the running run reads them at its next step, see agents/steering.ts),
 * waits for continuations and picks up runs started elsewhere.
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
  // Messages sent while the agent was working, shown after the answer until the saved messages include
  // them: the stream owns the list's last message meanwhile.
  const [sent, setSent] = useState<UIMessage[]>([]);
  const sentRef = useRef<UIMessage[]>([]);
  const updateSent = (update: (current: UIMessage[]) => UIMessage[]) => {
    sentRef.current = update(sentRef.current);
    setSent(sentRef.current);
  };
  // File parts carry no size; the cards look it up here.
  const [fileSizes, setFileSizes] = useState(initialFileSizes);
  const pickUpRef = useRef<() => void>(() => {});
  const { messages, setMessages, sendMessage, status, stop, addToolApprovalResponse, resumeStream, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    resume: resumeOnMount,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ id, messages }) => ({ body: { conversationId: id, message: messages.at(-1) } }),
    }),
    onError: (e) => toast.error(e.message),
    // When the answer ends with messages sent meanwhile, the saved messages show where they went in,
    // and a follow-up answering the ones that came too late is picked up. After Stop the run is still
    // winding down on the server; `settle` loads them once it has ended.
    onFinish: ({ isAbort }) => {
      if (!isAbort) setTimeout(() => pickUpRef.current(), 0);
    },
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
    const saved = new Set(res.data.messages.map((m) => m.id));
    updateSent((current) => current.filter((m) => !saved.has(m.id)));
    setFileSizes((sizes) => ({ ...sizes, ...res.data.fileSizes }));
    return { active: res.data.active, lastRole: res.data.messages.at(-1)?.role };
  }

  async function settle() {
    const state = await refresh();
    if (state && !state.active) setWaiting(false);
  }

  /** Loads the saved messages and follows a run that is still active: a new answer streams, a continuation is waited for. */
  async function pickUp() {
    const state = await refresh();
    if (!state?.active) return;
    if (state.lastRole === "user") await resumeStream();
    else setWaiting(true);
  }

  useEffect(() => {
    pickUpRef.current = () => {
      if (sentRef.current.length) void pickUp();
    };
  });

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
        await pickUp();
      } finally {
        startingRef.current = false;
      }
    })();
  });

  /**
   * A message written while the agent works goes out at once, outside the stream: the server saves it
   * and answers 409, and the running run reads it at its next step (or a follow-up answers it). When
   * the run ended meanwhile, the server starts one for it, which the chat picks up when its answer ends.
   */
  async function sendWhileBusy(message: UIMessage) {
    updateSent((current) => [...current, message]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
      });
      if (res.ok) void res.body?.cancel();
      else if (res.status !== 409) throw new Error(await res.text());
    } catch (error) {
      updateSent((current) => current.filter((m) => m.id !== message.id));
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  /** Sends a message with its uploaded files; while the agent works, without waiting for it. */
  function submit(message: { text: string; files: UploadedFile[] }) {
    if (message.files.length) {
      setFileSizes((sizes) => ({ ...sizes, ...Object.fromEntries(message.files.map((f) => [f.id, f.size])) }));
    }
    const files = message.files.map(toFilePart);
    if (!busy) return void sendMessage({ text: message.text, files });
    const text = message.text.trim();
    void sendWhileBusy({
      id: generateId(),
      role: "user",
      parts: [...files, ...(text ? [{ type: "text" as const, text }] : [])],
    });
  }

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
    sent,
    submit,
    decide,
    fileSizes,
  };
}

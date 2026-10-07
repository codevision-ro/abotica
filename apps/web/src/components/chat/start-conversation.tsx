"use client";

import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { startConversation } from "@/server/actions/chat";

type StartInput = Parameters<typeof startConversation>[0];

/**
 * Creates a web conversation and opens it; a refusal (e.g. the agent is not on the project's team)
 * shows as a toast. Without an agent, a project conversation starts with the project's manager and a
 * global one with the super agent.
 */
export function useStartConversation() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const start = (input: StartInput = {}, opts: { onStarted?: () => void; href?: (id: string) => string } = {}) =>
    startTransition(async () => {
      const res = await startConversation(input);
      if (!res.ok) return void toast.error(res.error);
      opts.onStarted?.();
      router.push(opts.href ? opts.href(res.data.id) : `/chat/${res.data.id}`);
    });
  return { start, pending };
}

/** A button that starts a conversation, e.g. "Chat" in an agent's or a project's header. */
export function StartConversationButton({
  input,
  children,
  variant,
  disabled,
  query = "",
}: {
  input: StartInput;
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>["variant"];
  disabled?: boolean;
  /** Search params the opened conversation keeps, e.g. the chat list's `?project=`. */
  query?: string;
}) {
  const { start, pending } = useStartConversation();
  return (
    <Button
      type="button"
      variant={variant}
      disabled={disabled || pending}
      onClick={() => start(input, { href: (id) => `/chat/${id}${query}` })}
    >
      {pending ? <Spinner /> : <MessageSquareIcon />}
      {children}
    </Button>
  );
}

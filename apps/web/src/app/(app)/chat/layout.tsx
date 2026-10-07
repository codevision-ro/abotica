import { ChatFrame } from "@/components/chat/conversation-list";

/** The conversation list comes from the `@list` slot, which can read the list's project filter. */
export default function ChatLayout({ children, list }: LayoutProps<"/chat">) {
  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 md:h-[calc(100svh-3.5rem-1rem)]">
      <ChatFrame list={list}>{children}</ChatFrame>
    </div>
  );
}

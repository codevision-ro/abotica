import { ConversationListSlot } from "@/components/chat/conversation-list-slot";

export default async function ChatListConversationPage(props: PageProps<"/chat/[id]">) {
  return <ConversationListSlot project={(await props.searchParams).project} />;
}

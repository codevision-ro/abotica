import { ConversationListSlot } from "@/components/chat/conversation-list-slot";

export default async function ChatListPage(props: PageProps<"/chat">) {
  return <ConversationListSlot project={(await props.searchParams).project} />;
}

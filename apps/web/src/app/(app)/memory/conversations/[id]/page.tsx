import { redirect } from "next/navigation";

/** Conversations are read in Chat now; old transcript links open them there. */
export default async function ConversationTranscriptPage(props: PageProps<"/memory/conversations/[id]">) {
  const { id } = await props.params;
  redirect(`/chat/${id}`);
}

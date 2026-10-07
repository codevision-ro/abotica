import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChatView } from "@/components/chat/chat-view";
import { isUuid } from "@/lib/uuid";
import { getChatModelState, getConversationMessages, getConversationWithAgent } from "@/server/queries/chat";

export async function generateMetadata(props: PageProps<"/chat/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const [found, t] = await Promise.all([isUuid(id) ? getConversationWithAgent(id) : null, getTranslations("nav")]);
  return { title: found?.conversation.title ?? t("items.chat") };
}

export default async function ChatPage(props: PageProps<"/chat/[id]">) {
  const { id } = await props.params;
  const found = isUuid(id) ? await getConversationWithAgent(id) : null;
  // Deleted or unknown conversation: fall back to the latest one instead of a blank page.
  if (!found) redirect("/chat");
  const { conversation, agent, project, testSkill } = found;
  const [history, modelState] = await Promise.all([getConversationMessages(id), getChatModelState(agent, conversation)]);
  // An answer to a new message can be streamed; a continuation of the last answer is waited for.
  const continues = history.messages.at(-1)?.role === "assistant";

  return (
    <ChatView
      key={id}
      conversationId={id}
      channel={conversation.channel}
      agent={{ name: agent.name, avatar: agent.avatar, role: agent.role }}
      project={project}
      testSkill={testSkill}
      modelState={modelState}
      initialMessages={history.messages}
      timestamps={history.timestamps}
      fileSizes={history.fileSizes}
      resume={history.active && !continues}
      waiting={history.active && continues}
    />
  );
}

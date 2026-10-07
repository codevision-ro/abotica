/** Pure rules for who answers a Telegram message. No server imports, so they are testable on their own. */
import type { Message } from "grammy/types";

/** The project mapped to a forum topic, with the agent that leads it. */
export type TopicProject = { id: string; name: string; managerAgentId: string | null };

/**
 * Who answers in a chat: the project's manager inside the project's forum topic, the super agent
 * everywhere else, or nobody when the topic's project has no manager yet.
 */
export type ChatRoute =
  | { kind: "orchestrator" }
  | { kind: "manager"; agentId: string; projectId: string }
  | { kind: "noManager"; project: string };

/**
 * The forum topic a message was sent in. Null in private chats, the General topic and reply threads
 * of groups without topics: those carry a message_thread_id too, but are not topics.
 */
export function topicOf(message: Pick<Message, "is_topic_message" | "message_thread_id"> | undefined): number | null {
  return message?.is_topic_message ? (message.message_thread_id ?? null) : null;
}

/** `project` is the one mapped to the message's topic, if any. */
export function routeChat(project: TopicProject | null | undefined): ChatRoute {
  if (!project) return { kind: "orchestrator" };
  if (!project.managerAgentId) return { kind: "noManager", project: project.name };
  return { kind: "manager", agentId: project.managerAgentId, projectId: project.id };
}

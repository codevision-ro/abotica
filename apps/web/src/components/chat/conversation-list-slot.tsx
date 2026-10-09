import { ALL, NO_PROJECT } from "@/lib/conversation-filter";
import { ConversationPanel } from "./conversation-list";
import { getConversationList, listChatAgents, listChatProjects, listConversationProjects } from "@/server/queries/chat";
import { parseConversationFilter } from "@/lib/conversation-filter";

/**
 * The chat's conversation list, rendered by the chat's `@list` slot so it reads `?project=` (a layout gets
 * no search params) and the server lists only the matching conversations.
 */
export async function ConversationListSlot({ project }: { project: string | string[] | undefined }) {
  const filter = parseConversationFilter(project);
  const [list, agents, projects, filterProjects] = await Promise.all([
    getConversationList(filter),
    listChatAgents(),
    listChatProjects(),
    listConversationProjects(),
  ]);
  return (
    <ConversationPanel
      // A new filter starts again from the first page.
      key={!filter ? ALL : (filter.projectId ?? NO_PROJECT)}
      list={list}
      agents={agents}
      projects={projects}
      filterProjects={filterProjects}
      filter={!filter ? ALL : (filter.projectId ?? NO_PROJECT)}
    />
  );
}

import { FolderKanbanIcon } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ConversationListTrigger } from "@/components/chat/conversation-list";
import { FirstConversationStarter } from "@/components/chat/first-conversation-starter";
import { StartConversationButton } from "@/components/chat/start-conversation";
import { ALL, filterQuery, NO_PROJECT, parseConversationFilter } from "@/lib/conversation-filter";
import { getLatestListedConversationId, getLatestOrchestratorConversationId } from "@/server/queries/chat";
import { getProject } from "@/server/queries/projects";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("items.chat") };
}

/**
 * Opens the latest conversation of the list, keeping its project filter. Unfiltered (or outside projects)
 * without one, the client creates a conversation with the super agent; a project without conversations
 * offers to start one with its manager.
 */
export default async function ChatIndexPage(props: PageProps<"/chat">) {
  const filter = parseConversationFilter((await props.searchParams).project);
  const query = filterQuery(!filter ? ALL : (filter.projectId ?? NO_PROJECT));
  const latestId = filter ? await getLatestListedConversationId(filter) : await getLatestOrchestratorConversationId();
  if (latestId) redirect(`/chat/${latestId}${query}`);

  const project = filter?.projectId ? await getProject(filter.projectId) : null;
  if (!project) return <FirstConversationStarter query={query} />;

  const t = await getTranslations("chat.projectEmpty");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-16 shrink-0 items-center border-b border-border/70 px-3 md:hidden">
        <ConversationListTrigger />
      </header>
      <div className="my-auto flex flex-col items-center px-4 py-10 text-center">
        <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/8 text-primary dark:bg-primary/15">
          <FolderKanbanIcon className="size-8" aria-hidden />
        </span>
        <h2 className="mt-5 max-w-xl text-xl font-semibold tracking-tight wrap-anywhere">
          {t("title", { project: project.name })}
        </h2>
        <p className="mt-1.5 max-w-md text-sm text-pretty text-muted-foreground">{t("description")}</p>
        <div className="mt-6">
          <StartConversationButton input={{ projectId: project.id }} query={query}>
            {t("start")}
          </StartConversationButton>
        </div>
      </div>
    </div>
  );
}

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { ListTodoIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { SectionCard, SectionIcon, SectionList, SectionRow } from "@/components/app/section-card";
import { TaskStatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { getFormat } from "@/server/format";

type AttentionTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
  projectName: string | null;
  agentName: string | null;
  agentAvatar: AgentAvatarValue | null;
};

/** Blocked tasks and tasks waiting for review; the dashboard shows it only when there are some. */
export async function AttentionTasksCard({ tasks, total }: { tasks: AttentionTask[]; total: number }) {
  const [t, tCommon, f] = await Promise.all([
    getTranslations("dashboard.attention"),
    getTranslations("common"),
    getFormat(),
  ]);
  return (
    <SectionCard
      icon={TriangleAlertIcon}
      title={t("title")}
      count={total}
      flush
      action={
        <Button asChild variant="ghost" size="sm">
          <Link href="/tasks">{tCommon("actions.viewAll")}</Link>
        </Button>
      }
    >
      <SectionList>
        {tasks.map((task) => (
          <SectionRow
            key={task.id}
            href={`/tasks?task=${task.id}`}
            media={
              task.agentName ? (
                <AgentAvatar avatar={task.agentAvatar} size="lg" />
              ) : (
                <SectionIcon icon={ListTodoIcon} className="bg-muted text-muted-foreground dark:bg-muted" />
              )
            }
            title={<span title={task.title}>{task.title}</span>}
            subtitle={[task.agentName, task.projectName, f.relative(task.updatedAt)].filter(Boolean).join(" · ")}
            trailing={<TaskStatusBadge status={task.status} />}
          />
        ))}
      </SectionList>
    </SectionCard>
  );
}

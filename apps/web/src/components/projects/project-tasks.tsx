import { ListTodoIcon, PlusIcon, UserIcon, UserRoundXIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import {
  SectionCard,
  SectionEmpty,
  SectionEmptyLink,
  SectionIcon,
  SectionList,
  SectionRow,
} from "@/components/app/section-card";
import { PriorityBadge, TASK_STATUSES, TaskStatusBadge } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import type { listProjectTasks } from "@/server/queries/projects";

type ProjectTask = Awaited<ReturnType<typeof listProjectTasks>>[number];

export async function ProjectTasks({ projectId, tasks }: { projectId: string; tasks: ProjectTask[] }) {
  const [t, tt, fmt] = await Promise.all([getTranslations("projects.tasks"), getTranslations("tasks"), getFormat()]);

  // Every status, paused and cancelled included, in board order; empty groups are left out.
  const groups = TASK_STATUSES.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  })).filter((g) => g.tasks.length);

  return (
    <SectionCard
      icon={ListTodoIcon}
      title={t("title")}
      count={tasks.length}
      description={t.rich("description", {
        link: (chunks) => <SectionEmptyLink href={`/tasks?project=${projectId}`}>{chunks}</SectionEmptyLink>,
      })}
      action={
        <Button asChild>
          <Link href={`/tasks?new=1&project=${projectId}`}>
            <PlusIcon />
            {t("newTask")}
          </Link>
        </Button>
      }
      flush
    >
      {groups.length ? (
        groups.map((g) => (
          <div key={g.status} className="border-border/60 not-first:border-t">
            <div className="flex items-center gap-2 bg-muted/30 px-4 py-2 sm:px-5">
              <TaskStatusBadge status={g.status} />
              <span className="tabular text-xs text-muted-foreground">{g.tasks.length}</span>
            </div>
            <SectionList className="border-t border-border/60">
              {g.tasks.map((task) => {
                const assignee = task.assignedToUser
                  ? tt("assignee.you")
                  : (task.assigneeName ?? tt("assignee.unassigned"));
                return (
                  <SectionRow
                    key={task.id}
                    href={`/tasks?task=${task.id}`}
                    media={
                      task.assigneeAvatar && !task.assignedToUser ? (
                        <AgentAvatar avatar={task.assigneeAvatar} size="lg" />
                      ) : (
                        <SectionIcon icon={task.assignedToUser ? UserIcon : UserRoundXIcon} variant="muted" />
                      )
                    }
                    title={
                      <span
                        title={task.title}
                        className={cn(
                          (task.status === "done" || task.status === "cancelled") && "text-muted-foreground line-through",
                        )}
                      >
                        {task.title}
                      </span>
                    }
                    subtitle={task.deadline ? `${assignee} · ${fmt.dateTime(task.deadline)}` : assignee}
                    trailing={<PriorityBadge priority={task.priority} />}
                  />
                );
              })}
            </SectionList>
          </div>
        ))
      ) : (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}

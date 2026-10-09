"use client";

import { CheckIcon, PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { resumeTask, updateTask } from "@/server/actions/tasks";

/**
 * The one action of a task row in the inbox: a task for the user is marked done, a blocked task the user
 * gave goes on (its agent resumes in the conversation it worked in).
 */
export function InboxTaskAction({ taskId, kind }: { taskId: string; kind: "task" | "blocked" }) {
  const t = useTranslations("inbox.task");
  const [pending, startTransition] = useTransition();

  function act() {
    startTransition(async () => {
      const res = kind === "task" ? await updateTask({ id: taskId, status: "done" }) : await resumeTask({ id: taskId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(kind === "task" ? t("marked") : t("resumed"));
    });
  }

  return (
    <Button variant="outline" size="xs" onClick={act} disabled={pending}>
      {pending ? <Spinner /> : kind === "task" ? <CheckIcon /> : <PlayIcon />}
      {kind === "task" ? t("markDone") : t("resume")}
    </Button>
  );
}

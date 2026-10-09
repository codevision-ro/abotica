"use client";

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { EllipsisIcon, PauseIcon, PlayIcon, SignpostIcon, XCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PRIORITIES, useStatusLabels } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { cancelTask, pauseTask, redirectTask, resumeTask } from "@/server/actions/tasks";
import { SELECT_WITH_MEDIA, TaskPriorityIcon } from "./task-icons";
import { fromLocalInput, toLocalInput } from "./task-meta";

/** What the controls need to know about a task. */
export type ControlledTask = {
  id: string;
  status: string;
  priority: string;
  deadline: Date | string | null;
  assigneeAgentId: string | null;
};

type AgentOption = { id: string; name: string; avatar: AgentAvatarValue | null; assignable: boolean };

/** A task can be put aside while it is waiting to start or in progress; settled work has nothing to pause. */
export const canPause = (status: string) => status === "backlog" || status === "in_progress";
export const canResume = (status: string) => status === "paused";
/** Done and cancelled tasks are over: nothing to redirect or cancel. */
export const isOpen = (status: string) => status !== "done" && status !== "cancelled";

/** Pause and resume, with their toasts; one pending state for both. */
function usePauseResume(taskId: string) {
  const t = useTranslations("tasks.control");
  const [pending, startTransition] = useTransition();
  const pause = () =>
    startTransition(async () => {
      const res = await pauseTask({ id: taskId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("paused"));
    });
  const resume = () =>
    startTransition(async () => {
      const res = await resumeTask({ id: taskId });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("resumed"));
    });
  return { pending, pause, resume };
}

/** The task page's pause or resume button: Resume is the page's primary action while the task is paused. */
export function PauseResumeButton({ task, disabled }: { task: ControlledTask; disabled?: boolean }) {
  const t = useTranslations("tasks.control");
  const { pending, pause, resume } = usePauseResume(task.id);
  if (canResume(task.status)) {
    return (
      <Button size="sm" onClick={resume} disabled={pending || disabled}>
        {pending ? <Spinner /> : <PlayIcon />}
        {t("resume")}
      </Button>
    );
  }
  if (!canPause(task.status)) return null;
  return (
    <Button size="sm" variant="outline" onClick={pause} disabled={pending || disabled}>
      {pending ? <Spinner /> : <PauseIcon />}
      {t("pause")}
    </Button>
  );
}

/**
 * The task's controls in a menu: Redirect and Cancel (each in its dialog), plus Pause or Resume when
 * `withPause` (the board's cards, which have no buttons of their own). Nothing for a task that is over.
 */
export function TaskControlMenu({
  task,
  agents,
  withPause,
  size = "icon-xs",
  className,
}: {
  task: ControlledTask;
  agents: AgentOption[];
  withPause?: boolean;
  size?: "icon-xs" | "icon-sm";
  className?: string;
}) {
  const t = useTranslations("tasks.control");
  const { pending, pause, resume } = usePauseResume(task.id);
  const [dialog, setDialog] = useState<"redirect" | "cancel" | null>(null);
  if (!isOpen(task.status)) return null;
  const close = (open: boolean) => !open && setDialog(null);

  return (
    // Keys and presses stay here: on a board card they would otherwise start dragging the card.
    <div
      className={cn("relative z-10", className)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={size}
            className="text-muted-foreground"
            aria-label={t("more")}
            title={t("more")}
            disabled={pending}
          >
            {pending ? <Spinner /> : <EllipsisIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {withPause && canPause(task.status) && (
            <DropdownMenuItem onSelect={pause}>
              <PauseIcon /> {t("pause")}
            </DropdownMenuItem>
          )}
          {withPause && canResume(task.status) && (
            <DropdownMenuItem onSelect={resume}>
              <PlayIcon /> {t("resume")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setDialog("redirect")}>
            <SignpostIcon /> {t("redirect")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDialog("cancel")}>
            <XCircleIcon /> {t("cancel")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mounted while open, so each opening starts from the task as it is now. */}
      {dialog === "redirect" && <RedirectDialog task={task} agents={agents} onOpenChange={close} />}
      {dialog === "cancel" && <CancelDialog taskId={task.id} onOpenChange={close} />}
    </div>
  );
}

function CancelDialog({ taskId, onOpenChange }: { taskId: string; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("tasks.control");
  const [reason, setReason] = useState("");
  const [cascade, setCascade] = useState(true);
  const [pending, startTransition] = useTransition();
  const reasonId = useId();
  const cascadeId = useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await cancelTask({ id: taskId, reason: reason.trim() || undefined, cascade });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("cancelled", { count: res.data.count }));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("cancelTitle")}</DialogTitle>
            <DialogDescription>{t("cancelDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={reasonId}>{t("reason")}</FieldLabel>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reasonPlaceholder")}
                rows={2}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id={cascadeId} checked={cascade} onCheckedChange={(v) => setCascade(v === true)} />
              <FieldLabel htmlFor={cascadeId} className="font-normal">
                {t("cascade")}
              </FieldLabel>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("keep")}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <Spinner />}
              {t("confirmCancel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const KEEP = "keep";

function RedirectDialog({
  task,
  agents,
  onOpenChange,
}: {
  task: ControlledTask;
  agents: AgentOption[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("tasks.control");
  const tc = useTranslations("common.actions");
  const labels = useStatusLabels();
  const [instructions, setInstructions] = useState("");
  const [assignee, setAssignee] = useState(KEEP);
  const [priority, setPriority] = useState(task.priority);
  const [deadline, setDeadline] = useState(toLocalInput(task.deadline));
  const [pending, startTransition] = useTransition();
  const ids = { instructions: useId(), assignee: useId(), priority: useId(), deadline: useId() };
  const candidates = agents.filter((a) => a.assignable && a.id !== task.assigneeAgentId);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const patch = {
      instructions: instructions.trim() || undefined,
      reassignTo: assignee === KEEP ? undefined : assignee,
      priority: priority === task.priority ? undefined : (priority as (typeof PRIORITIES)[number]),
      deadline: deadline === toLocalInput(task.deadline) ? undefined : fromLocalInput(deadline),
    };
    if (Object.values(patch).every((v) => v === undefined)) return void toast.error(t("nothingChanged"));
    startTransition(async () => {
      const res = await redirectTask({ id: task.id, ...patch });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("redirected"));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("redirectTitle")}</DialogTitle>
            <DialogDescription>{t("redirectDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={ids.instructions}>{t("instructions")}</FieldLabel>
              <Textarea
                id={ids.instructions}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t("instructionsPlaceholder")}
                rows={3}
              />
              <FieldDescription>{t("instructionsHint")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={ids.assignee}>{t("reassign")}</FieldLabel>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger id={ids.assignee} className={cn("w-full", SELECT_WITH_MEDIA)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
                  <SelectItem value={KEEP}>{t("keepAssignee")}</SelectItem>
                  {candidates.map((a) => (
                    <SelectItem key={a.id} value={a.id} title={a.name} className="*:[span]:last:min-w-0">
                      <AgentAvatar avatar={a.avatar} size="xs" />
                      <span className="truncate">{a.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={ids.priority}>{t("priority")}</FieldLabel>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id={ids.priority} className={cn("w-full", SELECT_WITH_MEDIA)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        <TaskPriorityIcon priority={p} />
                        {labels.priority(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.deadline}>{t("deadline")}</FieldLabel>
                <Input
                  id={ids.deadline}
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {t("submitRedirect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

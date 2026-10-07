"use client";

import { CalendarClockIcon, CornerLeftUpIcon, FolderIcon, Link2Icon, ListTodoIcon, UserIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { heroFieldVariants } from "@/components/app/hero-fields";
import { chipVariants } from "@/components/app/selectable-chip";
import { PRIORITIES, useStatusLabels } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useFormat } from "@/hooks/use-format";
import { cn } from "@/lib/utils";
import { createTask } from "@/server/actions/tasks";
import type { TaskOptions } from "@/server/queries/tasks";
import { SELECT_WITH_MEDIA, TaskPriorityIcon } from "./task-icons";
import { fromLocalInput, type TaskPriorityValue, useTaskParams } from "./task-meta";
import { TaskPicker } from "./task-picker";

const NONE = "none";

export function TaskNewDialog({ options }: { options: TaskOptions }) {
  const { searchParams, openOverlay, closeOverlay } = useTaskParams();
  const tc = useTranslations("common");
  const open = searchParams.get("new") === "1";
  // Set while the form has typed content: an accidental click outside must not discard it.
  const dirty = useRef(false);
  const setDirty = useCallback((v: boolean) => {
    dirty.current = v;
  }, []);

  // After create: back to the board/list, with a toast that opens the new task.
  function onCreated(id: string, message: string, warning: boolean) {
    closeOverlay({ new: null });
    const action = { label: tc("actions.open"), onClick: () => openOverlay({ task: id, new: null }) };
    if (warning) toast.warning(message, { action });
    else toast.success(message, { action });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeOverlay({ new: null })}>
      <DialogContent
        className="max-h-[90svh] min-w-0 gap-0 overflow-y-auto p-0 sm:max-w-[44rem]"
        onInteractOutside={(e) => dirty.current && e.preventDefault()}
      >
        {open && (
          <TaskNewForm
            options={options}
            defaultProject={searchParams.get("project")}
            onDirty={setDirty}
            onCancel={() => closeOverlay({ new: null })}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskNewForm({
  options,
  defaultProject,
  onDirty,
  onCancel,
  onCreated,
}: {
  options: TaskOptions;
  defaultProject: string | null;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onCreated: (id: string, message: string, warning: boolean) => void;
}) {
  const t = useTranslations("tasks");
  const tc = useTranslations("common");
  const labels = useStatusLabels();
  const fmt = useFormat();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(
    defaultProject && options.projects.some((p) => p.id === defaultProject) ? defaultProject : NONE,
  );
  const [assignee, setAssignee] = useState("user");
  const [priority, setPriority] = useState<TaskPriorityValue>("medium");
  const [deadline, setDeadline] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [parentId, setParentId] = useState(NONE);
  const [startNow, setStartNow] = useState(false);

  const agents = options.agents.filter((a) => a.assignable);
  const isAgent = assignee !== "user" && assignee !== NONE;
  const taskTitle = (id: string) => options.openTasks.find((t) => t.id === id)?.title ?? id;
  const dirty = !!(title.trim() || description.trim() || deadline || dependsOn.length);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return void toast.error(t("validation.titleRequired"));
    startTransition(async () => {
      const res = await createTask({
        title,
        description,
        projectId: projectId === NONE ? null : projectId,
        parentId: parentId === NONE ? null : parentId,
        priority,
        deadline: fromLocalInput(deadline),
        assignee,
        dependsOn,
        startNow: isAgent && startNow,
      });
      if (!res.ok) return void toast.error(res.error);
      if (res.data.runError) onCreated(res.data.id, t("new.runNotStarted", { error: res.data.runError }), true);
      else onCreated(res.data.id, isAgent && startNow ? t("new.createdAndStarted") : t("new.created"), false);
    });
  }

  const chip = cn(
    chipVariants({ selected: false }),
    "h-7 w-auto max-w-60 gap-1.5 py-0 pr-1.5 pl-2.5 text-[0.8rem] text-foreground data-[size=default]:h-7 dark:hover:bg-muted",
    SELECT_WITH_MEDIA,
  );

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col">
      <DialogHeader className="px-5 pt-5 pr-12">
        <DialogTitle className="flex items-center gap-2.5 text-sm font-medium">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary dark:bg-primary/15">
            <ListTodoIcon className="size-4" />
          </span>
          {t("new.title")}
        </DialogTitle>
        <DialogDescription className="sr-only">{t("new.description")}</DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-1 px-5 pt-4">
        <input
          id="task-title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("new.titlePlaceholder")}
          aria-label={t("new.titleLabel")}
          required
          className={cn(heroFieldVariants({ kind: "title" }), "text-xl")}
        />
        <textarea
          id="task-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("new.descriptionPlaceholder")}
          aria-label={t("new.descriptionLabel")}
          rows={4}
          className={cn(
            heroFieldVariants({ kind: "subtitle" }),
            "field-sizing-content min-h-24 resize-none py-1.5 text-sm",
          )}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 px-5 pt-3 pb-5">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="task-project" aria-label={t("new.projectLabel")} className={chip}>
            <FolderIcon className="text-muted-foreground" />
            <SelectValue>
              {projectId === NONE ? (
                <span className="text-muted-foreground">{t("new.projectLabel")}</span>
              ) : (
                options.projects.find((p) => p.id === projectId)?.name
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <SelectItem value={NONE}>{t("new.noProject")}</SelectItem>
            {options.projects.map((p) => (
              <SelectItem key={p.id} value={p.id} title={p.name} className="*:[span]:last:min-w-0">
                <span className="truncate">{p.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger id="task-assignee" aria-label={t("new.assigneeLabel")} className={chip}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <SelectItem value="user">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <UserIcon className="size-3!" />
              </span>
              {t("assignee.you")}
            </SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id} title={a.name} className="*:[span]:last:min-w-0">
                <AgentAvatar avatar={a.avatar} size="xs" />
                <span className="truncate">{a.name}</span>
              </SelectItem>
            ))}
            <SelectItem value={NONE}>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground">
                <UserIcon className="size-3!" />
              </span>
              {t("assignee.nobody")}
            </SelectItem>
          </SelectContent>
        </Select>

        <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriorityValue)}>
          <SelectTrigger id="task-priority" aria-label={t("new.priorityLabel")} className={chip}>
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

        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={t("new.deadlineLabel")} className={cn(chip, "pr-2.5")}>
              <CalendarClockIcon className="text-muted-foreground" />
              {deadline ? (
                <span className="truncate tabular">{fmt.date(new Date(deadline), "d MMM, HH:mm")}</span>
              ) : (
                <span className="text-muted-foreground">{t("new.deadlineLabel")}</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-auto flex-col gap-2 p-3">
            <Label htmlFor="task-deadline">{t("new.deadlineLabel")}</Label>
            <Input
              id="task-deadline"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
            {deadline && (
              <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setDeadline("")}>
                <XIcon />
                {tc("actions.remove")}
              </Button>
            )}
          </PopoverContent>
        </Popover>

        <TaskPicker
          tasks={options.openTasks}
          selected={dependsOn}
          onSelect={(id) => setDependsOn((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]))}
        >
          <button type="button" aria-label={t("new.dependsOnLabel")} className={cn(chip, "pr-2.5")}>
            <Link2Icon className="text-muted-foreground" />
            {dependsOn.length ? (
              <span className="truncate">{t("new.dependsOnSelected", { count: dependsOn.length })}</span>
            ) : (
              <span className="text-muted-foreground">{t("new.dependsOnLabel")}</span>
            )}
          </button>
        </TaskPicker>

        <Select value={parentId} onValueChange={setParentId}>
          <SelectTrigger id="task-parent" aria-label={t("new.parentLabel")} className={chip}>
            <CornerLeftUpIcon className="text-muted-foreground" />
            <SelectValue>
              {parentId === NONE ? (
                <span className="text-muted-foreground">{t("new.parentLabel")}</span>
              ) : (
                taskTitle(parentId)
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
            <SelectItem value={NONE}>{t("new.noParent")}</SelectItem>
            {options.openTasks
              .filter((t) => !t.parentId)
              .map((t) => (
                <SelectItem key={t.id} value={t.id} title={t.title} className="*:[span]:last:min-w-0">
                  <span className="truncate">{t.title}</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        {dependsOn.length > 0 && (
          <div className="flex w-full flex-wrap gap-1.5">
            {dependsOn.map((id) => (
              <Badge key={id} variant="secondary" className="max-w-full gap-1 pr-1 font-normal" title={taskTitle(id)}>
                <Link2Icon className="text-muted-foreground" />
                <span className="min-w-0 truncate">{taskTitle(id)}</span>
                <button
                  type="button"
                  aria-label={t("new.removeDependency")}
                  onClick={() => setDependsOn((d) => d.filter((x) => x !== id))}
                  className="rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-border/70 bg-muted/30 px-5 py-3 sm:flex-row sm:items-center">
        {isAgent && (
          <Field orientation="horizontal" className="w-auto">
            <Switch id="task-start" checked={startNow} onCheckedChange={setStartNow} />
            <FieldLabel htmlFor="task-start" className="font-normal">
              {t("new.startNow")}
            </FieldLabel>
          </Field>
        )}
        <div className="flex justify-end gap-2 sm:ml-auto">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tc("actions.cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending && <Spinner />}
            {t("new.submit")}
          </Button>
        </div>
      </div>
    </form>
  );
}

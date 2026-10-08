"use client";

import { hasUntrusted } from "@abotica/core/agents/untrusted";
import { FILE_MAX_BYTES } from "@abotica/core/limits";
import {
  CircleAlertIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  FileCheckIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  HourglassIcon,
  InfoIcon,
  Link2Icon,
  ListChecksIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UploadIcon,
  UserIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { heroFieldVariants } from "@/components/app/hero-fields";
import { RelativeTime } from "@/components/app/relative-time";
import { SectionCard, SectionEmpty, SectionList } from "@/components/app/section-card";
import { PRIORITIES, RunStatusBadge, TASK_STATUSES, TaskStatusBadge, useStatusLabels } from "@/components/app/status-badge";
import { UntrustedText } from "@/components/chat/untrusted-text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFormat } from "@/hooks/use-format";
import { type UploadedFile, uploadFiles } from "@/lib/upload-files";
import { cn } from "@/lib/utils";
import {
  createTask,
  createTaskComment,
  createTaskDependency,
  createTaskFiles,
  deleteTask,
  deleteTaskDependency,
  deleteTaskFile,
  startTaskRun,
  updateTask,
} from "@/server/actions/tasks";
import type { TaskDetailData, TaskOptions } from "@/server/queries/tasks";
import { SELECT_WITH_MEDIA, TaskPriorityIcon, TaskStatusIcon } from "./task-icons";
import {
  assigneeValue,
  focusAtEnd,
  fromLocalInput,
  isOverdue,
  tasksListHref,
  toLocalInput,
  useTaskParams,
} from "./task-meta";
import { TaskPicker } from "./task-picker";
import { PullRequestBadge } from "./task-pull-request";
import { TaskWakeups } from "./task-wakeups";

const NONE = "none";

type Patch = Omit<Parameters<typeof updateTask>[0], "id">;

/** Property controls read as plain values and only show a field on hover and focus. */
const PROPERTY_CONTROL =
  "h-8 w-full min-w-0 border-transparent bg-transparent px-2 shadow-none hover:bg-muted/60 data-[size=default]:h-8 dark:bg-transparent dark:hover:bg-muted/60";

/** Row whose title link covers the whole row; buttons in it sit above the link with `relative z-10`. */
const LINK_ROW = "relative flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-muted/40 sm:px-5";

export function TaskDetail({
  task,
  options,
  mode,
}: {
  task: TaskDetailData;
  options: TaskOptions;
  mode: "sheet" | "page";
}) {
  const router = useRouter();
  const t = useTranslations("tasks.detail");
  const tc = useTranslations("common");
  const { hrefWith, closeOverlay } = useTaskParams();
  const [, startTransition] = useTransition();
  // Their own transitions: saving a property must not disable Run now, deleting the task must.
  const [running, startRunTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();

  const taskHref = (id: string) => (mode === "sheet" ? hrefWith({ task: id }) : `/tasks/${id}`);

  function save(patch: Patch, success?: string) {
    startTransition(async () => {
      const res = await updateTask({ id: task.id, ...patch });
      if (!res.ok) toast.error(res.error);
      else if (success) toast.success(success);
    });
  }

  const pendingDeps = task.dependencies.filter((d) => d.dependsOn.status !== "done");
  const runBlockedReason = !task.assigneeAgentId
    ? t("runNeedsAgent")
    : pendingDeps.length
      ? t("runPendingDeps", { titles: pendingDeps.map((d) => d.dependsOn.title).join(", ") })
      : null;

  function run() {
    startRunTransition(async () => {
      const res = await startTaskRun({ id: task.id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("runStarted"), {
        action: { label: t("viewRun"), onClick: () => router.push(`/runs/${res.data.runId}`) },
      });
    });
  }

  function remove() {
    startDeleteTransition(async () => {
      const res = await deleteTask({ id: task.id });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      // Replace, not push: Back must not lead to the deleted task.
      if (mode === "sheet") closeOverlay({ task: null });
      else router.replace(tasksListHref());
    });
  }

  return (
    <div className="@container min-w-0 break-words">
      <div className="flex flex-col gap-5">
        <header className={cn("flex flex-col gap-3", mode === "sheet" && "pr-8")}>
          {task.parent && (
            <Link
              href={taskHref(task.parent.id)}
              replace={mode === "sheet"}
              scroll={false}
              title={task.parent.title}
              className="inline-flex max-w-full items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <CornerLeftUpIcon className="size-3.5 shrink-0" />
              <span className="truncate">{t("subtaskOf", { title: task.parent.title })}</span>
            </Link>
          )}
          <EditableTitle value={task.title} onSave={(title) => save({ title })} />
          {task.pullRequests.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {task.pullRequests.map((pr) => (
                <PullRequestBadge key={pr.id} pr={pr} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <RunButton
              label={task.failures.open ? t("startAnyway") : t("runNow")}
              reason={runBlockedReason}
              pending={running || deleting}
              onRun={run}
            />
            {mode === "sheet" && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/tasks/${task.id}`}>
                  <ExternalLinkIcon />
                  {t("openPage")}
                </Link>
              </Button>
            )}
            <ConfirmDialog
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={tc("actions.delete")}
                >
                  <Trash2Icon />
                </Button>
              }
              tooltip={tc("actions.delete")}
              title={t("deleteTitle")}
              description={t("deleteDescription")}
              confirm={tc("actions.delete")}
              destructive
              onConfirm={remove}
            />
          </div>
          {task.failures.open && <FailingRunsNotice failures={task.failures.failures} reason={task.failures.reason} />}
          {task.waitingForSlotSince && <WaitingForSlotNotice />}
        </header>

        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:grid-rows-[auto_auto_1fr]">
          <Properties task={task} options={options} onSave={save} className="@3xl:col-start-2 @3xl:row-start-1" />
          <div className="flex min-w-0 flex-col gap-4 @3xl:col-start-1 @3xl:row-span-3 @3xl:row-start-1">
            <MarkdownSection
              icon={FileTextIcon}
              title={t("description")}
              value={task.description}
              empty={t("noDescription")}
              placeholder={t("descriptionPlaceholder")}
              onSave={(description) => save({ description })}
            />
            <MarkdownSection
              icon={FileCheckIcon}
              title={t("output")}
              value={task.output ?? ""}
              empty={t("noOutput")}
              placeholder={t("outputPlaceholder")}
              onSave={(output) => save({ output: output || null })}
            />
            <Subtasks task={task} taskHref={taskHref} replaceLinks={mode === "sheet"} />
            <Dependencies task={task} options={options} taskHref={taskHref} replaceLinks={mode === "sheet"} />
            <Attachments task={task} />
            <Activity task={task} options={options} />
          </div>
          <TaskWakeups taskId={task.id} wakeups={task.wakeups} className="@3xl:col-start-2 @3xl:row-start-2" />
          <Runs
            task={task}
            className={cn("@3xl:col-start-2", task.wakeups.length ? "@3xl:row-start-3" : "@3xl:row-start-2")}
          />
        </div>
      </div>
    </div>
  );
}

function RunButton({
  label,
  reason,
  pending,
  onRun,
}: {
  label: string;
  reason: string | null;
  pending: boolean;
  onRun: () => void;
}) {
  const button = (
    <Button size="sm" onClick={onRun} disabled={!!reason || pending}>
      {pending ? <Spinner /> : <PlayIcon />}
      {label}
    </Button>
  );
  if (!reason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-lg">
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** The task's runs keep failing, so only the user starts it now (the run button says Start anyway). */
function FailingRunsNotice({ failures, reason }: { failures: number; reason: string | null }) {
  const t = useTranslations("tasks.detail");
  return (
    <Alert variant="destructive" className="border-destructive/25 bg-destructive/5">
      <CircleAlertIcon />
      <AlertTitle>{t("circuitOpen", { failures })}</AlertTitle>
      <AlertDescription className="space-y-1 wrap-anywhere [&_p:not(:last-child)]:mb-0">
        {reason && <p>{reason}</p>}
        <p className="text-muted-foreground">{t("circuitOpenHint")}</p>
      </AlertDescription>
    </Alert>
  );
}

/** Delegated while its conversation had no free place: it starts on its own, or now with Run now. */
function WaitingForSlotNotice() {
  const t = useTranslations("tasks.slots");
  return (
    <Alert>
      <HourglassIcon />
      <AlertTitle>{t("waiting")}</AlertTitle>
      <AlertDescription>{t("waitingHint")}</AlertDescription>
    </Alert>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const t = useTranslations("tasks.detail");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  }

  const titleClass = cn(heroFieldVariants({ kind: "title" }), "text-xl leading-snug sm:text-2xl");

  if (editing) {
    return (
      <input
        ref={focusAtEnd}
        value={draft}
        aria-label={t("titleLabel")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(titleClass, "bg-muted/60")}
      />
    );
  }
  return (
    <h2>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(titleClass, "block text-left break-words")}
        title={t("clickToEdit")}
      >
        {value}
      </button>
    </h2>
  );
}

function MarkdownSection({
  icon,
  title,
  value,
  empty,
  placeholder,
  onSave,
}: {
  icon: typeof FileTextIcon;
  title: string;
  value: string;
  empty: string;
  placeholder: string;
  onSave: (value: string) => void;
}) {
  const tc = useTranslations("common");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function save() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  function edit() {
    setDraft(value);
    setEditing(true);
  }

  return (
    <SectionCard
      icon={icon}
      title={title}
      action={
        !editing && (
          <Button size="icon-sm" variant="ghost" aria-label={tc("actions.edit")} title={tc("actions.edit")} onClick={edit}>
            <PencilIcon />
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            ref={focusAtEnd}
            value={draft}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            className="min-h-36 font-mono text-xs md:text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {tc("actions.cancel")}
            </Button>
            <Button size="sm" onClick={save}>
              {tc("actions.save")}
            </Button>
          </div>
        </div>
      ) : value.trim() ? (
        <MessageResponse breaks className="min-w-0 text-sm [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base">
          {value}
        </MessageResponse>
      ) : (
        <button
          type="button"
          onClick={edit}
          className="-m-1 rounded-md p-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {empty}
        </button>
      )}
    </SectionCard>
  );
}

function Properties({
  task,
  options,
  onSave,
  className,
}: {
  task: TaskDetailData;
  options: TaskOptions;
  onSave: (patch: Patch) => void;
  className?: string;
}) {
  const t = useTranslations("tasks");
  const labels = useStatusLabels();
  const fmt = useFormat();
  const [deadline, setDeadline] = useState(toLocalInput(task.deadline));
  const [syncedDeadline, setSyncedDeadline] = useState(task.deadline);
  if (task.deadline !== syncedDeadline) {
    setSyncedDeadline(task.deadline);
    setDeadline(toLocalInput(task.deadline));
  }

  const agents = options.agents.filter((a) => a.assignable || a.id === task.assigneeAgentId);
  const assignee = assigneeValue(task);

  return (
    <SectionCard icon={SlidersHorizontalIcon} title={t("detail.details")} className={className}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 @lg:grid-cols-2 @3xl:grid-cols-1">
        <Property label={t("detail.fields.status")} htmlFor="meta-status">
          <Select value={task.status} onValueChange={(v) => onSave({ status: v as (typeof TASK_STATUSES)[number] })}>
            <SelectTrigger id="meta-status" className={cn(PROPERTY_CONTROL, SELECT_WITH_MEDIA)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  <TaskStatusIcon status={s} />
                  {labels.task(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Property>
        <Property label={t("detail.fields.priority")} htmlFor="meta-priority">
          <Select value={task.priority} onValueChange={(v) => onSave({ priority: v as (typeof PRIORITIES)[number] })}>
            <SelectTrigger id="meta-priority" className={cn(PROPERTY_CONTROL, SELECT_WITH_MEDIA)}>
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
        </Property>
        <Property label={t("detail.fields.assignee")} htmlFor="meta-assignee">
          <Select value={assignee} onValueChange={(v) => onSave({ assignee: v })}>
            <SelectTrigger id="meta-assignee" className={cn(PROPERTY_CONTROL, SELECT_WITH_MEDIA)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
              <SelectItem value="user">
                <PersonTile />
                {t("assignee.you")}
              </SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id} title={a.name} className="*:[span]:last:min-w-0">
                  <AgentAvatar avatar={a.avatar} size="xs" />
                  <span className="truncate">{a.name}</span>
                </SelectItem>
              ))}
              <SelectItem value={NONE}>
                <PersonTile empty />
                {t("assignee.nobody")}
              </SelectItem>
            </SelectContent>
          </Select>
        </Property>
        <Property label={t("detail.fields.project")} htmlFor="meta-project">
          <Select value={task.projectId ?? NONE} onValueChange={(v) => onSave({ projectId: v === NONE ? null : v })}>
            <SelectTrigger id="meta-project" className={cn(PROPERTY_CONTROL, SELECT_WITH_MEDIA)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[min(28rem,calc(100vw-2rem))]">
              <SelectItem value={NONE}>
                <FolderIcon className="text-muted-foreground" />
                {t("new.noProject")}
              </SelectItem>
              {options.projects.map((p) => (
                <SelectItem key={p.id} value={p.id} title={p.name} className="*:[span]:last:min-w-0">
                  <FolderIcon className="text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Property>
        <Property label={t("detail.fields.deadline")} htmlFor="meta-deadline">
          <Input
            id="meta-deadline"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            onBlur={() => {
              if (deadline !== toLocalInput(task.deadline)) onSave({ deadline: fromLocalInput(deadline) });
            }}
            className={cn(
              PROPERTY_CONTROL,
              "text-sm md:text-sm",
              !deadline && "text-muted-foreground",
              isOverdue(task.deadline, task.status) && "text-destructive",
            )}
          />
        </Property>
        <Property label={t("detail.fields.created")}>
          <span className="block truncate px-2 text-sm" title={fmt.dateTime(task.createdAt)}>
            {fmt.dateTime(task.createdAt)}
          </span>
        </Property>
        {task.completedAt && (
          <Property label={t("detail.fields.completed")}>
            <RelativeTime date={task.completedAt} className="block truncate px-2 text-sm" />
          </Property>
        )}
      </dl>
    </SectionCard>
  );
}

function Property({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <dt className="text-sm text-muted-foreground">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}</dt>
      <dd className="-mr-2 min-w-0">{children}</dd>
    </div>
  );
}

/** "You" or "nobody" in places where agents show their avatar. */
function PersonTile({ empty }: { empty?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md",
        empty ? "border border-dashed border-muted-foreground/40 text-muted-foreground" : "bg-primary/10 text-primary",
      )}
    >
      <UserIcon className="size-3!" />
    </span>
  );
}

function Subtasks({
  task,
  taskHref,
  replaceLinks,
}: {
  task: TaskDetailData;
  taskHref: (id: string) => string;
  replaceLinks: boolean;
}) {
  const t = useTranslations("tasks.detail.subtasks");
  const tc = useTranslations("common");
  const labels = useStatusLabels();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, startTransition] = useTransition();
  const done = task.subtasks.filter((s) => s.status === "done").length;
  const total = task.subtasks.length;

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || pending) return;
    startTransition(async () => {
      const res = await createTask({ title, parentId: task.id, projectId: task.projectId });
      if (!res.ok) return void toast.error(res.error);
      setTitle("");
    });
  }

  return (
    <SectionCard
      icon={ListChecksIcon}
      title={t("title")}
      count={total}
      description={
        total > 0 && (
          <span className="flex items-center gap-2.5">
            <span className="tabular">{t("progress", { done, total })}</span>
            <span aria-hidden className="h-1 w-20 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-success" style={{ width: `${(done / total) * 100}%` }} />
            </span>
          </span>
        )
      }
      action={
        <Button size="sm" variant="ghost" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          <PlusIcon />
          {tc("actions.add")}
        </Button>
      }
      flush
    >
      <SectionList>
        {task.subtasks.map((s) => (
          <li key={s.id} className={LINK_ROW}>
            <TaskStatusIcon status={s.status} label={labels.task(s.status)} />
            <Link
              href={taskHref(s.id)}
              replace={replaceLinks}
              scroll={false}
              title={s.title}
              className={cn(
                "min-w-0 flex-1 truncate after:absolute after:inset-0",
                s.status === "done" && "text-muted-foreground",
              )}
            >
              {s.title}
            </Link>
            {s.assignee && (
              <span className="shrink-0" title={s.assignee.name}>
                <AgentAvatar avatar={s.assignee.avatar} size="sm" />
              </span>
            )}
          </li>
        ))}
        {adding && (
          <li className="px-4 py-2.5 sm:px-5">
            <form onSubmit={add}>
              <Input
                autoFocus
                value={title}
                // readOnly, not disabled: keeps focus so the next subtask can be typed right away.
                readOnly={pending}
                aria-busy={pending}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
                placeholder={t("placeholder")}
                aria-label={t("label")}
              />
            </form>
          </li>
        )}
      </SectionList>
      {!total && !adding && <SectionEmpty>{t("empty")}</SectionEmpty>}
    </SectionCard>
  );
}

function Dependencies({
  task,
  options,
  taskHref,
  replaceLinks,
}: {
  task: TaskDetailData;
  options: TaskOptions;
  taskHref: (id: string) => string;
  replaceLinks: boolean;
}) {
  const t = useTranslations("tasks.detail");
  const tc = useTranslations("common");
  const [pending, startTransition] = useTransition();
  const existing = new Set(task.dependencies.map((d) => d.dependsOnTaskId));
  const candidates = options.openTasks.filter((t) => t.id !== task.id && !existing.has(t.id));

  function mutate(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? t("error"));
    });
  }

  return (
    <SectionCard
      icon={Link2Icon}
      title={t("dependencies.title")}
      count={task.dependencies.length}
      action={
        <TaskPicker
          tasks={candidates}
          closeOnSelect
          onSelect={(id) => mutate(() => createTaskDependency({ taskId: task.id, dependsOnTaskId: id }))}
        >
          <Button size="sm" variant="ghost" disabled={pending}>
            <PlusIcon />
            {tc("actions.add")}
          </Button>
        </TaskPicker>
      }
      flush
    >
      {task.dependencies.length ? (
        <SectionList>
          {task.dependencies.map((d) => (
            <li key={d.dependsOnTaskId} className={LINK_ROW}>
              <TaskStatusIcon status={d.dependsOn.status} />
              <Link
                href={taskHref(d.dependsOn.id)}
                replace={replaceLinks}
                scroll={false}
                title={d.dependsOn.title}
                className="min-w-0 flex-1 truncate after:absolute after:inset-0"
              >
                {d.dependsOn.title}
              </Link>
              <TaskStatusBadge status={d.dependsOn.status} />
              <Button
                size="icon-xs"
                variant="ghost"
                className="relative z-10 text-muted-foreground"
                aria-label={t("dependencies.remove")}
                disabled={pending}
                onClick={() => mutate(() => deleteTaskDependency({ taskId: task.id, dependsOnTaskId: d.dependsOnTaskId }))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t("dependencies.empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}

const FILE_MAX_MB = FILE_MAX_BYTES / (1024 * 1024);

/** Files of the task, the user's uploads and what agents produced, in the files table. */
function Attachments({ task }: { task: TaskDetailData }) {
  const t = useTranslations("tasks");
  const tc = useTranslations("common");
  const tFiles = useTranslations("files");
  const fmt = useFormat();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  /** Share of the files uploaded so far; null when no upload runs. */
  const [progress, setProgress] = useState<number | null>(null);
  const busy = pending || progress !== null;

  async function upload(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (input.current) input.current.value = "";
    if (!files.length) return;
    const tooBig = files.find((f) => f.size > FILE_MAX_BYTES);
    if (tooBig) return void toast.error(tFiles("errors.tooLarge", { name: tooBig.name, max: FILE_MAX_MB }));
    let uploaded: UploadedFile[];
    try {
      uploaded = await uploadFiles(
        files.map((f) => ({ data: f, name: f.name })),
        { onProgress: setProgress, fallbackError: tFiles("errors.uploadFailed") },
      );
    } catch (error) {
      return void toast.error(error instanceof Error ? error.message : tFiles("errors.uploadFailed"));
    } finally {
      setProgress(null);
    }
    startTransition(async () => {
      const res = await createTaskFiles({ taskId: task.id, fileIds: uploaded.map((f) => f.id) });
      if (!res.ok) toast.error(res.error);
      else toast.success(t("detail.attachments.uploaded", { count: res.data.count }));
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteTaskFile({ taskId: task.id, id });
      if (!res.ok) toast.error(res.error);
    });
  }

  const addedBy = (file: TaskDetailData["files"][number]) =>
    file.source === "user"
      ? t("detail.attachments.addedByYou")
      : file.agentName
        ? t("detail.attachments.addedByAgent", { name: file.agentName })
        : t("detail.attachments.addedByAnAgent");

  return (
    <SectionCard
      icon={PaperclipIcon}
      title={t("detail.attachments.title")}
      count={task.files.length}
      action={
        <>
          <input
            ref={input}
            type="file"
            multiple
            className="sr-only"
            aria-label={t("detail.attachments.chooseFiles")}
            onChange={(e) => void upload(e.target.files)}
          />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <Spinner /> : <UploadIcon />}
            {progress !== null ? (
              <span className="tabular">{t("detail.attachments.uploading", { percent: Math.round(progress * 100) })}</span>
            ) : (
              t("detail.attachments.upload")
            )}
          </Button>
        </>
      }
      flush
    >
      {task.files.length ? (
        <SectionList>
          {task.files.map((a) => (
            <li key={a.id} className={LINK_ROW}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <FileIcon className="size-4" />
              </span>
              <a
                href={`/api/files/${a.id}`}
                title={a.name}
                className="flex min-w-0 flex-1 flex-col after:absolute after:inset-0"
                download={a.name}
              >
                <span className="truncate font-medium">{a.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  <span className="tabular">{fmt.fileSize(a.size)}</span> · {addedBy(a)}
                </span>
              </a>
              <ConfirmDialog
                trigger={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="relative z-10 text-muted-foreground"
                    aria-label={t("detail.attachments.delete", { name: a.name })}
                    disabled={busy}
                  >
                    <XIcon />
                  </Button>
                }
                title={tc("confirmDelete.title", { name: a.name })}
                description={tc("confirmDelete.description")}
                titleClassName="break-all"
                confirm={tc("actions.delete")}
                destructive
                onConfirm={() => remove(a.id)}
              />
            </li>
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t("detail.attachments.empty", { max: FILE_MAX_MB })}</SectionEmpty>
      )}
    </SectionCard>
  );
}

/** Fields with their own history message; any other field gets the generic "changes.unknown" line. */
const HISTORY_FIELD = {
  title: "title",
  status: "status",
  priority: "priority",
  deadline: "deadline",
  assigneeAgentId: "assignee",
  projectId: "project",
} as const;

type TimelineItem =
  | { kind: "comment"; at: number; comment: TaskDetailData["comments"][number] }
  | { kind: "event"; at: number; event: TaskDetailData["events"][number]; lines: string[] };

/** Comments and history in one timeline, oldest first, with the comment box at the end. */
function Activity({ task, options }: { task: TaskDetailData; options: TaskOptions }) {
  const t = useTranslations("tasks");
  const th = useTranslations("tasks.detail.history");
  const labels = useStatusLabels();
  const fmt = useFormat();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const agentName = (id: unknown) => options.agents.find((a) => a.id === id)?.name ?? th("values.nobody");
  const projectName = (id: unknown) => options.projects.find((p) => p.id === id)?.name ?? th("values.noProject");

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!body.trim() || pending) return;
    startTransition(async () => {
      const res = await createTaskComment({ taskId: task.id, body });
      if (!res.ok) return void toast.error(res.error);
      setBody("");
    });
  }

  function actor(actor: string): { name: string; media: React.ReactNode } {
    if (actor === "user") return { name: t("assignee.you"), media: <ActorTile kind="user" /> };
    if (actor === "system") return { name: th("system"), media: <ActorTile kind="system" /> };
    const slug = actor.startsWith("agent:") ? actor.slice(6) : actor;
    const agent = options.agents.find((a) => a.slug === slug);
    return {
      name: agent?.name ?? slug,
      media: <AgentAvatar avatar={agent?.avatar} size="sm" />,
    };
  }

  function value(field: string, v: unknown): string {
    if (v === null || v === undefined || v === "") {
      return field === "assigneeAgentId"
        ? th("values.nobody")
        : field === "projectId"
          ? th("values.noProject")
          : th("values.empty");
    }
    switch (field) {
      case "status":
        return labels.task(String(v));
      case "priority":
        return labels.priority(String(v));
      case "assigneeAgentId":
        return agentName(v);
      case "projectId":
        return projectName(v);
      case "deadline":
        return fmt.dateTime(String(v));
      default:
        return `"${String(v)}"`;
    }
  }

  /** One line per change, never a raw field or event name: unknown fields get a generic line, unknown events none. */
  function describe(type: string, data: Record<string, unknown>): string[] {
    if (type === "created") return [th("created")];
    if (type !== "updated") return [];
    const lines = Object.entries(data).flatMap(([field, change]) => {
      const { from, to } = (change ?? {}) as { from?: unknown; to?: unknown };
      if (field === "description") return [th("changes.description")];
      if (field === "output") return [th("changes.output")];
      if (field === "assignedToUser") return [to ? th("changes.assignedToYou") : th("changes.unassignedFromYou")];
      if (!(field in HISTORY_FIELD)) return [th("changes.unknown")];
      const values = { from: value(field, from), to: value(field, to) };
      return [th(`changes.${HISTORY_FIELD[field as keyof typeof HISTORY_FIELD]}`, values)];
    });
    return [...new Set(lines)];
  }

  const items: TimelineItem[] = [
    ...task.comments.map((c) => ({ kind: "comment" as const, at: new Date(c.createdAt).getTime(), comment: c })),
    ...task.events.flatMap((e) => {
      const lines = describe(e.type, e.data);
      return lines.length ? [{ kind: "event" as const, at: new Date(e.createdAt).getTime(), event: e, lines }] : [];
    }),
  ].sort((a, b) => a.at - b.at);

  return (
    <SectionCard icon={MessagesSquareIcon} title={t("detail.activity")} count={task.comments.length}>
      <div className="flex flex-col gap-5">
        {items.length > 0 && (
          <ol className="relative flex flex-col gap-4 before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border">
            {items.map((item) => {
              if (item.kind === "comment") {
                const c = item.comment;
                const name =
                  c.authorKind === "system"
                    ? t("detail.comments.system")
                    : c.authorKind === "agent"
                      ? (c.author?.name ?? t("detail.comments.deletedAgent"))
                      : t("assignee.you");
                return (
                  <li key={`c-${c.id}`} className="relative flex flex-col gap-1.5">
                    <div className="flex min-w-0 items-center gap-2.5 text-sm">
                      <span className="relative flex rounded-md ring-4 ring-card">
                        {c.authorKind !== "system" && c.author ? (
                          <AgentAvatar avatar={c.author.avatar} size="sm" />
                        ) : (
                          <ActorTile kind={c.authorKind === "system" ? "system" : "user"} />
                        )}
                      </span>
                      <span className="truncate font-medium" title={c.author?.name}>
                        {name}
                      </span>
                      <RelativeTime date={c.createdAt} className="shrink-0 text-xs text-muted-foreground" />
                    </div>
                    <div className="ml-8.5 min-w-0 rounded-xl border border-border/70 bg-background/60 px-3 py-2 dark:bg-background/30">
                      {hasUntrusted(c.body) ? (
                        // A system note carrying outside text (CI logs, review comments): shown as data, not Markdown.
                        <div className="text-sm whitespace-pre-wrap">
                          <UntrustedText text={c.body} />
                        </div>
                      ) : (
                        <MessageResponse breaks className="text-sm">
                          {c.body}
                        </MessageResponse>
                      )}
                    </div>
                  </li>
                );
              }
              const e = item.event;
              const who = actor(e.actor);
              return (
                <li key={`e-${e.id}`} className="relative flex min-w-0 items-center gap-2.5 text-sm">
                  <span className="relative flex rounded-md ring-4 ring-card">{who.media}</span>
                  <p className="min-w-0 flex-1 text-muted-foreground">
                    <span className="font-medium text-foreground">{who.name}</span>{" "}
                    {item.lines.map((line, i) => (
                      <Fragment key={i}>
                        {i > 0 && <br />}
                        {line}
                      </Fragment>
                    ))}
                    <span aria-hidden> · </span>
                    <RelativeTime date={e.createdAt} className="text-xs" />
                  </p>
                </li>
              );
            })}
          </ol>
        )}
        <form onSubmit={submit} className="flex flex-col gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder={t("detail.comments.placeholder")}
            aria-label={t("detail.comments.label")}
            className="min-h-20 bg-background dark:bg-input/30"
          />
          <Button type="submit" size="sm" variant="outline" className="self-end" disabled={pending || !body.trim()}>
            {pending && <Spinner />}
            {t("detail.comments.submit")}
          </Button>
        </form>
      </div>
    </SectionCard>
  );
}

function ActorTile({ kind }: { kind: "user" | "system" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        kind === "user" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {kind === "system" ? <InfoIcon className="size-3.5" /> : <UserIcon className="size-3.5" />}
    </span>
  );
}

function Runs({ task, className }: { task: TaskDetailData; className?: string }) {
  const t = useTranslations("tasks.detail.runs");
  const labels = useStatusLabels();
  const fmt = useFormat();
  return (
    <SectionCard icon={WorkflowIcon} title={t("title")} count={task.runs.length} className={className} flush>
      {task.runs.length ? (
        <SectionList>
          {task.runs.map((r) => (
            <li key={r.id}>
              <Link
                href={`/runs/${r.id}`}
                className="flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60 sm:px-5"
              >
                <AgentAvatar avatar={r.agentAvatar} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.agentName ?? t("deletedAgent")}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {labels.trigger(r.trigger)} · <RelativeTime date={r.createdAt} />
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <RunStatusBadge status={r.status} />
                  <span className="text-xs text-muted-foreground tabular">{fmt.usd(r.costUsd)}</span>
                </span>
              </Link>
            </li>
          ))}
        </SectionList>
      ) : (
        <SectionEmpty>{t("empty")}</SectionEmpty>
      )}
    </SectionCard>
  );
}

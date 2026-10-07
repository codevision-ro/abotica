"use client";

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { useStatusLabels } from "@/components/app/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { createTask, moveTask } from "@/server/actions/tasks";
import type { BoardTask } from "@/server/queries/tasks";
import { SortableTaskCard, TaskCard } from "./task-card";
import { TaskStatusIcon } from "./task-icons";
import { TASK_STATUS_ORDER, type TaskStatusValue, useTaskParams } from "./task-meta";

const COLUMN_PREFIX = "column:";

function sortByPosition(list: BoardTask[]) {
  return [...list].sort((a, b) => a.position - b.position);
}

export function TaskBoard({
  tasks,
  showAllDone,
  projectId,
}: {
  tasks: BoardTask[];
  showAllDone: boolean;
  projectId?: string;
}) {
  const t = useTranslations("tasks.board");
  const te = useTranslations("errors");
  const { hrefWith } = useTaskParams();
  const [items, setItems] = useState(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const snapshot = useRef<BoardTask[] | null>(null);
  const justDragged = useRef(false);

  // Server data wins whenever it changes (revalidation, live events), except mid-drag.
  useEffect(() => {
    if (!snapshot.current) setItems(tasks);
  }, [tasks]);

  const columns = useMemo(() => {
    const map = Object.fromEntries(TASK_STATUS_ORDER.map((s) => [s, [] as BoardTask[]])) as Record<
      TaskStatusValue,
      BoardTask[]
    >;
    for (const t of items) map[t.status as TaskStatusValue]?.push(t);
    for (const s of TASK_STATUS_ORDER) map[s] = sortByPosition(map[s]);
    return map;
  }, [items]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const statusOf = (id: string): TaskStatusValue | undefined => {
    if (id.startsWith(COLUMN_PREFIX)) return id.slice(COLUMN_PREFIX.length) as TaskStatusValue;
    return items.find((t) => t.id === id)?.status as TaskStatusValue | undefined;
  };

  function onDragStart({ active }: DragStartEvent) {
    snapshot.current = items;
    setActiveId(String(active.id));
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const from = statusOf(String(active.id));
    const to = statusOf(String(over.id));
    if (!from || !to || from === to) return;
    // Preview the card in the target column; final position is computed on drop.
    setItems((prev) => {
      const overTask = prev.find((t) => t.id === over.id);
      const target = sortByPosition(prev.filter((t) => t.status === to));
      const position = overTask ? overTask.position - 0.001 : (target.at(-1)?.position ?? 0) + 1;
      return prev.map((t) => (t.id === active.id ? { ...t, status: to, position } : t));
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const before = snapshot.current;
    snapshot.current = null;
    setActiveId(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    if (!over || !before) {
      if (before) setItems(before);
      return;
    }

    const id = String(active.id);
    const status = statusOf(String(over.id)) ?? statusOf(id);
    if (!status) return;
    let column = sortByPosition(items.filter((t) => t.status === status || t.id === id)).map((t) =>
      t.id === id ? { ...t, status } : t,
    );
    const oldIndex = column.findIndex((t) => t.id === id);
    const overIndex = column.findIndex((t) => t.id === over.id);
    const newIndex = overIndex >= 0 ? overIndex : column.length - 1;
    column = arrayMove(column, oldIndex, newIndex);

    const prevPos = column[newIndex - 1]?.position;
    const nextPos = column[newIndex + 1]?.position;
    let position: number;
    if (prevPos !== undefined && nextPos !== undefined) position = (prevPos + nextPos) / 2;
    else if (prevPos !== undefined) position = prevPos + 1024;
    else if (nextPos !== undefined) position = nextPos - 1024;
    else position = 1024;

    const original = before.find((t) => t.id === id);
    if (!original) return;
    const beforeOrder = sortByPosition(before.filter((t) => t.status === status)).map((t) => t.id);
    if (original.status === status && column.map((t) => t.id).join() === beforeOrder.join()) {
      setItems(before);
      return;
    }

    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, status, position } : t)));
    const rollback = (error: string) => {
      setItems(before);
      toast.error(t("moveFailed", { error }));
    };
    moveTask({ id, status, position }).then(
      (res) => {
        if (!res.ok) rollback(res.error);
      },
      () => rollback(te("unknown")),
    );
  }

  function onDragCancel() {
    if (snapshot.current) setItems(snapshot.current);
    snapshot.current = null;
    setActiveId(null);
  }

  const active = activeId ? items.find((t) => t.id === activeId) : undefined;

  return (
    <DndContext
      id="task-board"
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div
        className="-mx-4 flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:snap-none md:px-0"
        onClickCapture={(e) => {
          if (justDragged.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {TASK_STATUS_ORDER.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={columns[status]}
            hrefFor={(id) => hrefWith({ task: id, new: null })}
            projectId={projectId}
            footer={
              status === "done" && !showAllDone ? (
                <Link
                  href={hrefWith({ showAllDone: "1" })}
                  scroll={false}
                  className="block rounded-lg px-2 py-1.5 text-center text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  {t("recentDoneOnly")}
                </Link>
              ) : null
            }
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{active ? <TaskCard task={active} href="#" overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  hrefFor,
  footer,
  projectId,
}: {
  status: TaskStatusValue;
  tasks: BoardTask[];
  hrefFor: (id: string) => string;
  footer: React.ReactNode;
  projectId?: string;
}) {
  const t = useTranslations("tasks.board");
  const label = useStatusLabels().task(status);
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status}` });
  const [adding, setAdding] = useState(false);

  return (
    <section
      aria-label={label}
      className={cn(
        "flex w-[85vw] max-w-80 shrink-0 snap-start flex-col rounded-2xl border border-border/50 bg-muted/35 transition-colors md:w-auto md:max-w-none md:min-w-52 md:flex-1 dark:bg-muted/20",
        isOver && "border-primary/40 bg-primary/5 dark:bg-primary/8",
      )}
    >
      <header className="flex items-center gap-2 py-2 pr-2 pl-3.5">
        <TaskStatusIcon status={status} />
        <h2 className="min-w-0 truncate text-sm font-medium">{label}</h2>
        <span className="rounded-full bg-background/80 px-1.5 text-xs leading-5 text-muted-foreground tabular shadow-[inset_0_0_0_1px_var(--border)] dark:bg-background/40">
          {tasks.length}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-muted-foreground"
          aria-label={t("addToColumn", { status: label })}
          aria-expanded={adding}
          // Keep focus in the open quick-add input: its blur would close it and this click would reopen it.
          onMouseDown={(e) => adding && e.preventDefault()}
          onClick={() => setAdding((v) => !v)}
        >
          <PlusIcon />
        </Button>
      </header>
      {adding && <QuickAdd status={status} projectId={projectId} onDone={() => setAdding(false)} />}
      <div ref={setNodeRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} href={hrefFor(task.id)} />
          ))}
        </SortableContext>
        {tasks.length === 0 && !adding && (
          <p
            className={cn(
              "rounded-xl border border-dashed border-border/80 px-3 py-5 text-center text-xs text-muted-foreground transition-colors",
              isOver && "border-primary/40 text-primary",
            )}
          >
            {t("dropHere")}
          </p>
        )}
        {footer}
      </div>
    </section>
  );
}

function QuickAdd({ status, projectId, onDone }: { status: TaskStatusValue; projectId?: string; onDone: () => void }) {
  const t = useTranslations("tasks.board");
  const [title, setTitle] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    const value = title.trim();
    if (pending) return;
    if (!value) return onDone();
    startTransition(async () => {
      const res = await createTask({ title: value, status, projectId: projectId ?? null });
      if (!res.ok) return void toast.error(res.error);
      setTitle("");
      toast.success(t("created"));
    });
  }

  return (
    <form
      className="px-2 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        value={title}
        // readOnly, not disabled: a disabled input loses focus, and the next title typed would go nowhere.
        readOnly={pending}
        aria-busy={pending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        onBlur={() => !title.trim() && onDone()}
        placeholder={t("quickAddPlaceholder")}
        aria-label={t("quickAddLabel")}
        className="bg-background shadow-xs"
      />
    </form>
  );
}

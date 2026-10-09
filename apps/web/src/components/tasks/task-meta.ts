"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** The board's columns; cancelled is shown only on request (?cancelled=1). */
export const TASK_STATUS_ORDER = ["backlog", "in_progress", "paused", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatusValue = (typeof TASK_STATUS_ORDER)[number];
export type TaskPriorityValue = "low" | "medium" | "high" | "urgent";

export const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Value used by assignee selects: "user", "none" or an agent id. */
export function assigneeValue(task: { assigneeAgentId?: string | null; agentId?: string | null; assignedToUser: boolean }) {
  const agentId = task.assigneeAgentId ?? task.agentId;
  if (agentId) return agentId;
  return task.assignedToUser ? "user" : "none";
}

export function isOverdue(deadline: Date | string | null, status: string) {
  return !!deadline && status !== "done" && status !== "cancelled" && new Date(deadline).getTime() < Date.now();
}

/** Converts a Date to the value expected by <input type="datetime-local"> in local time. */
export function toLocalInput(date: Date | string | null | undefined) {
  if (!date) return "";
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  return value ? new Date(value).toISOString() : null;
}

/** Ref callback for inline editors: focus once on mount with the caret after the existing text. */
export function focusAtEnd(el: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

/**
 * URL the ?task= sheet or ?new= dialog was opened from in this tab. Closing the overlay goes back to it
 * instead of pushing a new entry, so the browser Back button does not reopen the overlay just closed.
 */
let overlayBase: string | null = null;

/** Call when opening an overlay with a push (setParams or a Link click), before navigating. */
export function rememberOverlayBase(e?: React.MouseEvent) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
  overlayBase = normalizeHref(window.location.pathname + window.location.search);
}

function normalizeHref(href: string) {
  const url = new URL(href, "http://x");
  return `${url.pathname}?${new URLSearchParams(url.search).toString()}`;
}

/** URL state helpers for /tasks: filters, ?task= sheet and ?new= dialog. */
export function useTaskParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const hrefWith = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams],
  );

  const setParams = useCallback(
    (patch: Record<string, string | null | undefined>, mode: "push" | "replace" = "push") => {
      const href = hrefWith(patch);
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [hrefWith, router],
  );

  /** Opens the sheet or dialog with a history entry, so Back (or the Android back gesture) closes it. */
  const openOverlay = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      rememberOverlayBase();
      setParams(patch, "push");
    },
    [setParams],
  );

  /** Closes the sheet or dialog: back to the entry it was opened from, or a replace for deep links. */
  const closeOverlay = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const href = hrefWith(patch);
      const base = overlayBase;
      overlayBase = null;
      if (base && base === normalizeHref(href)) {
        router.back();
      } else {
        router.replace(href, { scroll: false });
      }
    },
    [hrefWith, router],
  );

  return { searchParams, hrefWith, setParams, openOverlay, closeOverlay };
}

const LIST_HREF_KEY = "abotica:tasks-list-href";

/** Remembers the board/list URL with its filters, so the task page can link back to it. */
export function saveTasksListHref(searchParams: URLSearchParams) {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("task");
  params.delete("new");
  const qs = params.toString();
  try {
    sessionStorage.setItem(LIST_HREF_KEY, qs ? `/tasks?${qs}` : "/tasks");
  } catch {}
}

export function tasksListHref() {
  try {
    return sessionStorage.getItem(LIST_HREF_KEY) ?? "/tasks";
  } catch {
    return "/tasks";
  }
}

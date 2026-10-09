"use client";

import { useRef } from "react";

/**
 * Focus for dialogs with no Radix trigger: `remember` the element that opens one (the focused one by
 * default) and pass `restoreFocus` as the dialog's `onCloseAutoFocus`, which gives focus back to it.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: (element: Element | null = document.activeElement) => {
      opener.current = element instanceof HTMLElement ? element : null;
    },
    restoreFocus: (e: Event) => {
      if (!opener.current?.isConnected) return;
      e.preventDefault();
      opener.current.focus();
    },
  };
}

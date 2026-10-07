"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { NAVIGATE_EVENT } from "@/lib/navigation-guard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Asks before leaving a form with unsaved changes: in-app link clicks and announced programmatic
 * navigation (command menu) get a confirmation dialog, reloads and tab closes get the browser prompt.
 */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const t = useTranslations("agents.unsaved");
  const router = useRouter();
  /** The navigation waiting for confirmation. */
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    // Capture phase on document runs before Next's Link handler on the anchor.
    function onClick(e: MouseEvent) {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      e.preventDefault();
      e.stopPropagation();
      const href = url.pathname + url.search + url.hash;
      setPending(() => () => router.push(href));
    }
    function onNavigate(e: WindowEventMap[typeof NAVIGATE_EVENT]) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      setPending(() => e.detail.proceed);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, onNavigate);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [router]);

  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("stay")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              const proceed = pending;
              dirtyRef.current = false;
              setPending(null);
              proceed?.();
            }}
          >
            {t("leave")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

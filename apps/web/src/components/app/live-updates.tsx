"use client";

import type { AppEvent } from "@abotica/core/events";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";

type Listener = (event: AppEvent) => void;
const LiveContext = createContext<{ subscribe: (l: Listener) => () => void } | null>(null);

/**
 * One EventSource per tab. Server components refresh (debounced) on any event;
 * client components can also subscribe for finer-grained reactions.
 */
export function LiveUpdates({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const listeners = useRef(new Set<Listener>());
  const [ctx] = useState(() => ({
    subscribe: (l: Listener) => {
      listeners.current.add(l);
      return () => void listeners.current.delete(l);
    },
  }));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource("/api/events");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as AppEvent;
      for (const l of listeners.current) l(event);
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 400);
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [router]);

  return <LiveContext.Provider value={ctx}>{children}</LiveContext.Provider>;
}

export function useLiveEvent(listener: Listener) {
  const ctx = useContext(LiveContext);
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => ctx?.subscribe((e) => ref.current(e)), [ctx]);
}

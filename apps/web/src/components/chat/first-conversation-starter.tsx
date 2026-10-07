"use client";

import { useEffect, useRef } from "react";
import { useStartConversation } from "./start-conversation";

/**
 * Creates the first web conversation through a server action: rendering a page (which also
 * happens on prefetch) must not write to the database. `query` keeps the chat list's filter.
 */
export function FirstConversationStarter({ query = "" }: { query?: string }) {
  const { start } = useStartConversation();
  const started = useRef(false);
  useEffect(() => {
    // Strict mode runs effects twice in development: create one conversation only.
    if (started.current) return;
    started.current = true;
    start({}, { href: (id) => `/chat/${id}${query}` });
  }, [start, query]);
  return null;
}

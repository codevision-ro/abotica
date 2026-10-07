"use client";

import { useRef, useState } from "react";
import { detectMcpServerAuth } from "@/server/actions/mcp";

type Auth = "headers" | "oauth";

export type McpAuthDetection = ReturnType<typeof useMcpAuthDetection>;

/** Like Claude custom connectors: probe the URL and pick OAuth when the server asks for it. */
export function useMcpAuthDetection({
  initialUrl,
  transport,
  isNew,
  setAuth,
}: {
  initialUrl: string;
  transport: "http" | "stdio";
  isNew: boolean;
  setAuth: (auth: Auth) => void;
}) {
  /** The user picked the auth method by hand, so detection no longer switches it. */
  const [authTouched, setAuthTouched] = useState(false);
  const [detecting, setDetecting] = useState(false);
  /** Last detection result and whether it switched the auth method on its own. */
  const [detected, setDetected] = useState<{ auth: Auth | null; switched: boolean } | null>(null);
  const probedUrl = useRef(initialUrl.trim());
  const latestUrl = useRef(initialUrl);
  const probeSeq = useRef(0);

  async function detectAuth(value: string) {
    const target = value.trim();
    if (transport !== "http" || target === probedUrl.current) return;
    if (!URL.canParse(target) || !/^https?:$/.test(new URL(target).protocol)) return;
    probedUrl.current = target;
    const seq = ++probeSeq.current;
    setDetecting(true);
    let found: Auth | null = null;
    try {
      const res = await detectMcpServerAuth({ url: target });
      found = res.ok ? res.data.auth : null;
    } catch {
      // Best effort: a probe that fails to reach the app counts as nothing detected.
    } finally {
      if (seq === probeSeq.current) setDetecting(false);
    }
    if (seq !== probeSeq.current) return;
    // The URL changed while probing: the next blur probes the new one.
    if (latestUrl.current.trim() !== target) return;
    if (isNew && !authTouched && found) {
      setAuth(found);
      setDetected({ auth: found, switched: found === "oauth" });
    } else {
      setDetected({ auth: found, switched: false });
    }
  }

  return {
    detecting,
    detected,
    detectAuth,
    /** Call on every URL edit, so a probe for an outdated URL is ignored. */
    trackUrl: (value: string) => {
      latestUrl.current = value;
    },
    markAuthTouched: () => setAuthTouched(true),
  };
}

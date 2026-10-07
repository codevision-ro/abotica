"use client";

import type { ProviderId } from "@abotica/core";
import { CircleCheck, CircleX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { testProvider } from "@/server/actions/settings";

type TestState = { ok: true; model: string; latencyMs: number; text: string } | { ok: false; error: string };

/** Runs the connection test of one provider and keeps its last result. */
export function useProviderTest(provider: ProviderId) {
  const [testing, startTest] = useTransition();
  const [result, setResult] = useState<TestState | null>(null);
  const run = () =>
    startTest(async () => {
      setResult(null);
      const res = await testProvider({ provider });
      setResult(res.ok ? { ok: true, ...res.data } : { ok: false, error: res.error });
    });
  return { testing, result, run, reset: () => setResult(null) };
}

export function ProviderTestResult({ result }: { result: TestState | null }) {
  const t = useTranslations("settings.providers");
  if (!result) return null;
  return result.ok ? (
    <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
      <CircleCheck className="size-4 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {t.rich("testOk", {
          ms: result.latencyMs,
          model: result.model,
          num: (chunks) => <span className="tabular">{chunks}</span>,
          mono: (chunks) => <span className="font-mono text-xs">{chunks}</span>,
        })}
      </span>
    </p>
  ) : (
    <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <CircleX className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{result.error}</span>
    </p>
  );
}

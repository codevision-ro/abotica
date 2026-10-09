"use client";

import { PlugZapIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { SummaryItem } from "@/components/app/summary-rail";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { McpTestResult, testMcpById } from "@/server/actions/mcp";
import { McpTestResultView, McpToolBadge } from "./mcp-test-result";

/** Connection test of a server page: the last result, and `run` to test with a server action. */
export function useMcpTest() {
  const tr = useTranslations("mcp.testResult");
  const [result, setResult] = useState<McpTestResult | null>(null);
  const [testing, startTest] = useTransition();

  function run(call: () => ReturnType<typeof testMcpById>) {
    startTest(async () => {
      setResult(null);
      const res = await call();
      if (!res.ok) return void toast.error(res.error);
      setResult(res.data);
      // The result sits further down the form; a toast confirms the outcome where the user is.
      if (res.data.ok) toast.success(tr("connected", { count: res.data.tools.length }));
      else toast.error(tr("failed"), { description: res.data.error ?? tr("unknownError") });
    });
  }

  return { result, testing, run };
}

/** The test's line in the summary rail. */
export function McpTestSummaryItem({
  target,
  result,
  testing,
  toolCount,
}: {
  target: string;
  result: McpTestResult | null;
  testing: boolean;
  toolCount: number | null;
}) {
  const t = useTranslations("mcp.form");
  const tr = useTranslations("mcp.testResult");
  const done = result && !testing ? result.ok : null;
  return (
    <SummaryItem
      target={target}
      status={done === null ? "info" : done ? "done" : "todo"}
      statusLabel={done === null ? undefined : done ? t("complete") : t("incomplete")}
      label={t("testTitle")}
    >
      {testing
        ? t("connecting")
        : result
          ? result.ok
            ? tr("connected", { count: result.tools.length })
            : tr("failed")
          : toolCount != null
            ? t("lastSeen", { count: toolCount })
            : t("notTested")}
    </SummaryItem>
  );
}

/** Last connection test of the form, with a secondary button to run it again. */
export function McpFormTest({
  id,
  result,
  testing,
  slug,
  oauthMode,
  toolCount,
  cachedTools,
  onTest,
}: {
  /** Section id, the rail's scroll target. */
  id: string;
  result: McpTestResult | null;
  testing: boolean;
  slug: string;
  oauthMode: boolean;
  /** Tools seen on the last successful connection; null until the first one. */
  toolCount: number | null;
  /** Names of the tools seen on the last successful connection, listed until a new test runs. */
  cachedTools?: string[];
  onTest: () => void;
}) {
  const t = useTranslations("mcp.form");
  const tc = useTranslations("common.actions");

  return (
    <FormSection
      id={id}
      icon={PlugZapIcon}
      title={t("testTitle")}
      description={oauthMode ? t("testDescriptionOAuth") : t("testDescription")}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={testing} title={t("testConnection")}>
          {testing ? <Spinner /> : <ZapIcon />} {tc("test")}
        </Button>
      }
    >
      {result && !testing ? (
        <McpTestResultView result={result} slug={slug || "slug"} />
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            {testing ? (
              <>
                <Spinner className="size-3.5" /> {t("connecting")}
              </>
            ) : toolCount != null ? (
              t("lastSeen", { count: toolCount })
            ) : (
              t("testHint")
            )}
          </p>
          {!testing && cachedTools && cachedTools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {cachedTools.map((tool) => (
                <McpToolBadge key={tool} slug={slug} tool={tool} />
              ))}
            </div>
          )}
        </>
      )}
    </FormSection>
  );
}

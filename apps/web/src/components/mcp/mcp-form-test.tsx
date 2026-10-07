"use client";

import { PlugZapIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection } from "@/components/app/form-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { McpTestResult } from "@/server/actions/mcp";
import { Badge } from "@/components/ui/badge";
import { mcpToolName, McpTestResultView } from "./mcp-test-result";

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
                <Badge
                  key={tool}
                  variant="outline"
                  className="max-w-full bg-background font-mono font-normal"
                  title={mcpToolName(slug, tool)}
                >
                  <span className="truncate">{mcpToolName(slug, tool)}</span>
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </FormSection>
  );
}

"use client";

import { ListIcon, LogInIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { Button } from "@/components/ui/button";
import type { McpOAuthStatus } from "@/server/queries/mcp";
import { KeyValueEditor, type KeyValueRow, keyCount } from "./key-value-editor";
import { McpOAuthAdvanced, McpOAuthPanel, type OAuthClientValue } from "./mcp-oauth-panel";
import type { McpAuthDetection } from "./use-mcp-auth-detection";

/** Authentication of an HTTP server: method (with the detection hint), OAuth connection and headers. */
export function McpFormAuth({
  auth,
  onAuthChange,
  detection,
  serverId,
  serverName,
  oauth,
  dirty,
  willConnect,
  connecting,
  onConnect,
  client,
  onClientChange,
  redirectUrl,
  headerRows,
  onHeaderRowsChange,
  secretNames,
  secretsHint,
}: {
  auth: "headers" | "oauth";
  onAuthChange: (auth: "headers" | "oauth") => void;
  detection: McpAuthDetection;
  serverId?: string;
  serverName: string;
  oauth: McpOAuthStatus | null;
  dirty: boolean;
  willConnect: boolean;
  connecting: boolean;
  onConnect: () => void;
  client: OAuthClientValue;
  onClientChange: (value: OAuthClientValue) => void;
  redirectUrl: string;
  headerRows: KeyValueRow[];
  onHeaderRowsChange: (rows: KeyValueRow[]) => void;
  secretNames: string[];
  /** How values reference vault secrets, shown under the headers. */
  secretsHint: React.ReactNode;
}) {
  const t = useTranslations("mcp.form");
  const { detected, markAuthTouched } = detection;
  const oauthMode = auth === "oauth";

  return (
    <>
      {/* Clicking the already selected card is a choice too, so detection stops switching it. */}
      <div onClickCapture={markAuthTouched} className="flex flex-col gap-2">
        <OptionCards
          name="mcp-auth"
          label={t("authTitle")}
          value={auth}
          onValueChange={(v) => {
            markAuthTouched();
            onAuthChange(v);
          }}
          options={[
            { value: "headers", icon: ListIcon, title: t("authHeaders"), description: t("authHeadersHint") },
            { value: "oauth", icon: LogInIcon, title: t("authOAuth"), description: t("authOAuthHint") },
          ]}
        />
        {detected?.auth === "oauth" && auth === "oauth" && detected.switched && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden /> {t("authDetected")}
          </p>
        )}
        {detected?.auth === "oauth" && auth === "headers" && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
            {t("authSuggest")}
            <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={() => onAuthChange("oauth")}>
              {t("useOAuth")}
            </Button>
          </p>
        )}
      </div>
      {oauthMode && (
        <div className="flex min-w-0 flex-col gap-2">
          <McpOAuthPanel
            serverId={serverId}
            serverName={serverName}
            status={oauth}
            dirty={dirty}
            willConnect={willConnect}
            connecting={connecting}
            onConnect={onConnect}
          />
          <McpOAuthAdvanced value={client} onChange={onClientChange} redirectUrl={redirectUrl} secretNames={secretNames} />
        </div>
      )}
      <FormSubsection
        title={oauthMode ? t("extraHeaders") : t("headers")}
        count={keyCount(headerRows)}
        description={secretsHint}
      >
        <KeyValueEditor
          rows={headerRows}
          onChange={onHeaderRowsChange}
          secretNames={secretNames}
          keyPlaceholder="Authorization"
          valuePlaceholder="Bearer {{secret:GITHUB_TOKEN}}"
          addLabel={t("addHeader")}
        />
      </FormSubsection>
    </>
  );
}

"use client";

import { GlobeIcon, TerminalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { KeyValueEditor, type KeyValueRow } from "./key-value-editor";

/** Transport choice and its endpoint: the URL for HTTP, command, arguments and environment for stdio. */
export function McpFormTransport({
  transport,
  onTransportChange,
  url,
  onUrlChange,
  onUrlCommit,
  command,
  onCommandChange,
  argsText,
  onArgsTextChange,
  envRows,
  onEnvRowsChange,
  secretNames,
  secretsHint,
}: {
  transport: "http" | "stdio";
  onTransportChange: (transport: "http" | "stdio") => void;
  url: string;
  onUrlChange: (url: string) => void;
  /** The URL was blurred or pasted: time to probe it. */
  onUrlCommit: (url: string) => void;
  command: string;
  onCommandChange: (command: string) => void;
  argsText: string;
  onArgsTextChange: (argsText: string) => void;
  envRows: KeyValueRow[];
  onEnvRowsChange: (rows: KeyValueRow[]) => void;
  secretNames: string[];
  /** How values reference vault secrets, shown under the environment variables. */
  secretsHint: React.ReactNode;
}) {
  const t = useTranslations("mcp.form");

  return (
    <>
      <OptionCards
        name="mcp-transport"
        label={t("transport")}
        value={transport}
        onValueChange={onTransportChange}
        options={[
          { value: "http", icon: GlobeIcon, title: t("transportHttp"), description: t("transportHttpHint") },
          { value: "stdio", icon: TerminalIcon, title: t("transportStdio"), description: t("transportStdioHint") },
        ]}
      />

      {transport === "http" ? (
        <Field>
          <FieldLabel htmlFor="mcp-url">{t("url")}</FieldLabel>
          <Input
            id="mcp-url"
            type="url"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            onBlur={(e) => onUrlCommit(e.currentTarget.value)}
            onPaste={(e) => {
              const input = e.currentTarget;
              setTimeout(() => onUrlCommit(input.value));
            }}
            placeholder="https://example.com/mcp"
            className="font-mono"
            required
          />
        </Field>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="mcp-command">{t("command")}</FieldLabel>
            <Input
              id="mcp-command"
              value={command}
              onChange={(e) => onCommandChange(e.target.value)}
              placeholder="npx"
              className="font-mono"
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-args">{t("args")}</FieldLabel>
            <Textarea
              id="mcp-args"
              value={argsText}
              onChange={(e) => onArgsTextChange(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"}
              className="font-mono text-xs md:text-xs"
              rows={4}
              spellCheck={false}
            />
            <FieldDescription>{t("argsHint")}</FieldDescription>
          </Field>
          <FormSubsection title={t("env")} count={envRows.filter((r) => r.key.trim()).length} description={secretsHint}>
            <KeyValueEditor
              rows={envRows}
              onChange={onEnvRowsChange}
              secretNames={secretNames}
              keyPlaceholder="API_KEY"
              valuePlaceholder="{{secret:API_KEY}}"
              addLabel={t("addVariable")}
            />
          </FormSubsection>
        </>
      )}
    </>
  );
}

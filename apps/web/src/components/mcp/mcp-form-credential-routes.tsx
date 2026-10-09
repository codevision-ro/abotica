"use client";

import { KeyRound, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { FormSubsection } from "@/components/app/form-section";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { McpCredentialRouteDraft } from "@abotica/core/mcp-servers";
import type { StoredValue } from "@abotica/core/mcp-stored-values";
import type { McpCredentialRoute } from "@abotica/db";
import { SecretInsertMenu } from "./secret-insert-menu";

/** A saved route as the form gets it: the value only when it references the vault, otherwise null (hidden). */
export type CredentialRouteValue = Omit<McpCredentialRoute, "value"> & { value: StoredValue };

/**
 * One route. `keep` marks a saved value the server did not send: the row keeps it, under the variable
 * it was saved with, until a new value is typed.
 */
type CredentialRouteRow = {
  baseUrlEnv: string;
  upstream: string;
  header: string;
  value: string;
  keyEnv: string;
  keep?: string;
};

const EMPTY_ROW: CredentialRouteRow = { baseUrlEnv: "", upstream: "", header: "", value: "", keyEnv: "" };

export function toRouteRows(routes: CredentialRouteValue[]): CredentialRouteRow[] {
  return routes.map(({ value, keyEnv = "", ...route }) =>
    value === null ? { ...route, keyEnv, value: "", keep: route.baseUrlEnv } : { ...route, keyEnv, value },
  );
}

/** Rows left entirely empty are dropped; anything else goes to the server, which checks it. */
export function toRouteDrafts(rows: CredentialRouteRow[]): McpCredentialRouteDraft[] {
  return rows
    .filter((r) => r.keep || [r.baseUrlEnv, r.upstream, r.header, r.value, r.keyEnv].some((v) => v.trim()))
    .map(({ keep, value, keyEnv, ...route }) => ({
      ...route,
      value: keep && !value ? { keep } : value,
      keyEnv: keyEnv.trim() || null,
    }));
}

export const routeCount = (rows: CredentialRouteRow[]) => toRouteDrafts(rows).length;

/**
 * Credential routes of a sandboxed stdio server: the egress proxy adds a header with a secret to the
 * server's requests to an upstream API, so the secret never enters the sandbox.
 */
export function McpFormCredentialRoutes({
  rows,
  onChange,
  secretNames,
  secretsHint,
}: {
  rows: CredentialRouteRow[];
  onChange: (rows: CredentialRouteRow[]) => void;
  secretNames: string[];
  /** How values reference vault secrets, shown under the description. */
  secretsHint: React.ReactNode;
}) {
  const t = useTranslations("mcp.form.credentialRoutes");
  const tk = useTranslations("mcp.keyValue");
  const id = useId();
  const update = (i: number, patch: Partial<CredentialRouteRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <FormSubsection
      title={t("title")}
      count={routeCount(rows)}
      description={
        <>
          {t("description")} {secretsHint}
        </>
      }
    >
      {rows.map((row, i) => {
        const field = (name: keyof CredentialRouteRow) => `${id}-${i}-${name}`;
        const text = (name: "baseUrlEnv" | "upstream" | "header" | "keyEnv", placeholder: string) => (
          <Input
            id={field(name)}
            value={row[name]}
            onChange={(e) => update(i, { [name]: e.target.value })}
            placeholder={placeholder}
            title={row[name] || undefined}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-xs"
          />
        );
        return (
          <div key={i} className="flex items-start gap-2 rounded-xl border bg-background/60 p-3 dark:bg-input/10">
            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={field("baseUrlEnv")}>{t("baseUrlEnv")}</FieldLabel>
                {text("baseUrlEnv", "OPENAI_BASE_URL")}
              </Field>
              <Field>
                <FieldLabel htmlFor={field("upstream")}>{t("upstream")}</FieldLabel>
                {text("upstream", "https://api.openai.com/v1")}
              </Field>
              <Field>
                <FieldLabel htmlFor={field("header")}>{t("header")}</FieldLabel>
                {text("header", "Authorization")}
              </Field>
              <Field>
                <FieldLabel htmlFor={field("value")}>{t("value")}</FieldLabel>
                <div className="flex items-center gap-1">
                  <Input
                    id={field("value")}
                    value={row.value}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder={row.keep ? tk("hiddenValue") : "Bearer {{secret:OPENAI_KEY}}"}
                    title={row.keep && !row.value ? tk("hiddenValueHint") : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 font-mono text-xs"
                  />
                  <SecretInsertMenu
                    secretNames={secretNames}
                    onPick={(name) => update(i, { value: `${row.value}{{secret:${name}}}` })}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tk("insertSecret")}
                      title={tk("insertSecret")}
                    >
                      <KeyRound />
                    </Button>
                  </SecretInsertMenu>
                </div>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={field("keyEnv")}>{t("keyEnv")}</FieldLabel>
                {text("keyEnv", "OPENAI_API_KEY")}
                <FieldDescription className="text-xs">{t("keyEnvHint")}</FieldDescription>
              </Field>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("remove")}
              title={t("remove")}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, EMPTY_ROW])}
      >
        <Plus /> {t("add")}
      </Button>
    </FormSubsection>
  );
}

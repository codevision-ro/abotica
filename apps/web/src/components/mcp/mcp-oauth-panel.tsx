"use client";

import {
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  LogIn,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useNow, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RelativeTime } from "@/components/app/relative-time";
import { type Tone, ToneBadge } from "@/components/app/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { disconnectMcpOAuth } from "@/server/actions/mcp";
import type { McpOAuthStatus } from "@/server/queries/mcp";
import { SecretInsertMenu } from "./secret-insert-menu";

type State = McpOAuthStatus["state"];

const OAUTH_TONE: Record<State, Tone> = { connected: "success", disconnected: "warning", error: "warning" };

const WARNING_TEXT = "text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning";

/** `subtle`: a connected server gets a plain outline badge with only a green dot (list cards). */
export function OAuthStatusBadge({
  state,
  label,
  title,
  subtle,
}: {
  state: State;
  label: string;
  title?: string;
  subtle?: boolean;
}) {
  if (subtle && state === "connected") {
    return (
      <Badge variant="outline" className="gap-1.5" title={title}>
        <span className="size-1.5 rounded-full bg-success" />
        {label}
      </Badge>
    );
  }
  return (
    <ToneBadge tone={OAUTH_TONE[state]} title={title}>
      {label}
    </ToneBadge>
  );
}

const STATE_ICON: Record<State, { icon: LucideIcon; className: string }> = {
  connected: {
    icon: ShieldCheck,
    className: "bg-success/12 text-[color-mix(in_oklch,var(--success),black_15%)] dark:text-success",
  },
  disconnected: { icon: KeyRound, className: "bg-warning/15 " + WARNING_TEXT },
  error: { icon: TriangleAlert, className: "bg-warning/15 " + WARNING_TEXT },
};

/**
 * Connection state of an OAuth MCP server. Connecting goes through the form's primary button, so the
 * panel only explains; a connected server gets Reconnect and Disconnect while the form has no edits.
 * `dirty`: the form has unsaved edits. `willConnect`: saving goes straight on to the authorization page.
 */
export function McpOAuthPanel({
  serverId,
  serverName,
  status,
  dirty,
  willConnect,
  connecting,
  onConnect,
}: {
  serverId?: string;
  serverName: string;
  status: McpOAuthStatus | null;
  dirty: boolean;
  willConnect: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const t = useTranslations("mcp.oauth");
  const router = useRouter();
  const [disconnecting, startDisconnect] = useTransition();
  const now = useNow({ updateInterval: 60_000 });

  const state: State = serverId && status ? status.state : "disconnected";
  const { icon: Icon, className: iconClass } = STATE_ICON[state];

  function disconnect() {
    if (!serverId) return;
    startDisconnect(async () => {
      const res = await disconnectMcpOAuth({ id: serverId });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("disconnected"));
      router.refresh();
    });
  }

  const connected = state === "connected" && status;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-background/60 p-3 dark:bg-input/10">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", iconClass)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {t("title")}
            <OAuthStatusBadge state={state} label={t(`status.${state}`)} />
          </p>
          <p className="text-xs text-pretty text-muted-foreground">
            {connected
              ? status.connectedAt
                ? t.rich("connectedAt", { time: () => <RelativeTime date={status.connectedAt!} /> })
                : t("status.connected")
              : state === "error"
                ? t("errorBody")
                : t("disconnectedBody")}
          </p>
        </div>
      </div>

      {connected && (status.scope || status.expiresAt) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t pt-3 text-xs">
          {status.scope && (
            <>
              <dt className="text-muted-foreground">{t("scope")}</dt>
              <dd className="min-w-0 font-mono wrap-anywhere">{status.scope}</dd>
            </>
          )}
          {status.expiresAt && (
            <>
              <dt className="text-muted-foreground">{t("token")}</dt>
              <dd>
                {t.rich(new Date(status.expiresAt) > now ? "expiresIn" : "expiredAt", {
                  time: () => <RelativeTime date={status.expiresAt!} />,
                })}
              </dd>
            </>
          )}
        </dl>
      )}
      {state === "error" && status?.error && (
        <p className="rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs text-muted-foreground wrap-anywhere">
          {status.error}
        </p>
      )}

      {dirty
        ? willConnect &&
          (state === "disconnected" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LogIn className="size-3.5 shrink-0" aria-hidden />
              {t("afterSave")}
            </p>
          ) : (
            <p className={cn("flex items-center gap-2 text-xs", WARNING_TEXT)}>
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {t("afterSaveReconnect")}
            </p>
          ))
        : connected && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onConnect} disabled={connecting || disconnecting}>
                {connecting ? <Spinner /> : <RefreshCw />} {t("reconnect")}
              </Button>
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="ghost" size="sm" disabled={disconnecting || connecting}>
                    {disconnecting ? <Spinner /> : <Unplug />} {t("disconnect")}
                  </Button>
                }
                title={t("disconnectTitle", { name: serverName })}
                description={t("disconnectDescription")}
                confirm={t("disconnect")}
                destructive
                onConfirm={disconnect}
              />
            </div>
          )}
    </div>
  );
}

/**
 * `keepSecret`: a saved client secret the server did not send (it does not reference the vault);
 * it stays while `clientSecret` is empty, until the user types a new one or removes it.
 */
export type OAuthClientValue = { clientId: string; clientSecret: string; keepSecret: boolean; scope: string };

/** Optional pre-registered OAuth app; empty means dynamic client registration. */
export function McpOAuthAdvanced({
  value,
  onChange,
  redirectUrl,
  secretNames,
}: {
  value: OAuthClientValue;
  onChange: (value: OAuthClientValue) => void;
  redirectUrl: string;
  secretNames: string[];
}) {
  const t = useTranslations("mcp.oauth");
  const tk = useTranslations("mcp.keyValue");
  const [open, setOpen] = useState(Boolean(value.clientId || value.clientSecret || value.keepSecret || value.scope));
  const hiddenSecret = value.keepSecret && !value.clientSecret;
  const [copied, setCopied] = useState(false);
  const set = (patch: Partial<OAuthClientValue>) => onChange({ ...value, ...patch });

  async function copy() {
    try {
      await navigator.clipboard.writeText(redirectUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/advanced flex min-w-0 flex-col gap-3">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start">
          <ChevronRight className="transition-transform group-data-[state=open]/advanced:rotate-90" />
          {t("advanced")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col gap-4">
        <Field>
          <FieldDescription>{t("advancedHint")}</FieldDescription>
          <InputGroup>
            <InputGroupInput
              id="mcp-oauth-redirect"
              readOnly
              value={redirectUrl}
              aria-label={t("redirectUri")}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t("copyRedirectUri")}
                title={t("copyRedirectUri")}
                onClick={() => void copy()}
              >
                {copied ? <Check /> : <Copy />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="mcp-oauth-client-id">{t("clientId")}</FieldLabel>
            <Input
              id="mcp-oauth-client-id"
              value={value.clientId}
              onChange={(e) => set({ clientId: e.target.value })}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-oauth-client-secret">{t("clientSecret")}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="mcp-oauth-client-secret"
                value={value.clientSecret}
                onChange={(e) => set({ clientSecret: e.target.value })}
                placeholder={hiddenSecret ? tk("hiddenValue") : "{{secret:CLIENT_SECRET}}"}
                title={hiddenSecret ? tk("hiddenValueHint") : undefined}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <InputGroupAddon align="inline-end">
                {hiddenSecret && (
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={t("removeClientSecret")}
                    title={t("removeClientSecret")}
                    onClick={() => set({ keepSecret: false })}
                  >
                    <X />
                  </InputGroupButton>
                )}
                <SecretInsertMenu secretNames={secretNames} onPick={(name) => set({ clientSecret: `{{secret:${name}}}` })}>
                  <InputGroupButton size="icon-xs" aria-label={tk("insertSecret")} title={tk("insertSecret")}>
                    <KeyRound />
                  </InputGroupButton>
                </SecretInsertMenu>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="mcp-oauth-scope">{t("scope")}</FieldLabel>
          <Input
            id="mcp-oauth-scope"
            value={value.scope}
            onChange={(e) => set({ scope: e.target.value })}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <FieldDescription>{t("scopeHint")}</FieldDescription>
        </Field>
      </CollapsibleContent>
    </Collapsible>
  );
}

"use client";

import { MCP_TIMEOUTS, type StoredValue } from "@abotica/core/mcp-stored-values";
import type { NetworkPolicy } from "@abotica/core/sandbox-policy";
import { slugify } from "@abotica/core/slug";
import {
  BoxesIcon,
  BoxIcon,
  CableIcon,
  FolderOpenIcon,
  LockKeyholeIcon,
  LogInIcon,
  RefreshCwIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { DangerZoneCard } from "@/components/app/danger-zone-card";
import { FormPage } from "@/components/app/form-page";
import { FormSection, FormSectionCollapsible, FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { SummaryItem, SummaryList, type SummaryStatus } from "@/components/app/summary-rail";
import { NetworkPolicyEditor, usePolicySummary } from "@/components/sandbox/sandbox-policy-editor";
import { SettingsNumberField } from "@/components/settings/settings-number-field";
import type { PickerOption } from "@/components/skills/assignment-picker";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { cn } from "@/lib/utils";
import {
  connectMcpOAuth,
  createMcpServer,
  deleteMcpServer,
  type McpTestResult,
  testMcpById,
  testMcpDraft,
  updateMcpServer,
} from "@/server/actions/mcp";
import type { McpOAuthStatus } from "@/server/queries/mcp";
import { AssignmentChips } from "./assignment-chips";
import { McpActiveSwitch, McpGlobalSwitch } from "./mcp-switch-row";
import { type KeyValueRow, toRecord, toRows } from "./key-value-editor";
import { McpFormAuth } from "./mcp-form-auth";
import {
  type CredentialRouteValue,
  McpFormCredentialRoutes,
  routeCount,
  toRouteDrafts,
  toRouteRows,
} from "./mcp-form-credential-routes";
import { McpFormTest } from "./mcp-form-test";
import { McpFormTransport } from "./mcp-form-transport";
import type { OAuthClientValue } from "./mcp-oauth-panel";
import { McpServerIcon } from "./mcp-server-icon";
import { useMcpAuthDetection } from "./use-mcp-auth-detection";
import { useMcpOAuthReturn } from "./use-mcp-oauth-return";

type McpFormValue = {
  id?: string;
  name: string;
  slug: string;
  transport: "http" | "stdio";
  url: string;
  command: string;
  args: string[];
  /** Saved values that do not reference the vault come as null: the server keeps them hidden. */
  env: Record<string, StoredValue>;
  headers: Record<string, StoredValue>;
  /** Stdio only: what the sandboxed process may reach. */
  network: NetworkPolicy;
  /** Stdio only: false runs the process directly in the worker. */
  sandboxed: boolean;
  /** Sandboxed stdio only: "run" starts the process in the workspace of the run that uses it. */
  workspace: "server" | "run";
  /** Sandboxed stdio only: the egress proxy adds a secret header to the server's requests upstream. */
  credentialRoutes: CredentialRouteValue[];
  /** Seconds; null uses the default (MCP_TIMEOUTS). */
  connectTimeoutSec: number | null;
  callTimeoutSec: number | null;
  auth: "headers" | "oauth";
  oauthClientId: string;
  /** The saved client secret when it references the vault; empty otherwise. */
  oauthClientSecret: string;
  /** A saved client secret the server did not send. */
  oauthClientSecretHidden: boolean;
  oauthScope: string;
  enabled: boolean;
  /** Offered to every agent; the assignments are kept for when it is turned off. */
  global: boolean;
  agentIds: string[];
  projectIds: string[];
};

const SLUG_RE = /^[a-z0-9-]+$/;

/** Sent instead of the client secret to keep the saved one (the same object, so comparisons hold). */
const KEEP_SECRET = { keep: true } as const;

/** Section ids: scroll targets of the summary rail. */
const SECTIONS = {
  identity: "mcp-identity",
  connection: "mcp-connection",
  sandbox: "mcp-sandbox",
  auth: "mcp-auth",
  test: "mcp-test",
  advanced: "mcp-advanced",
  assignment: "mcp-assignment",
} as const;

/** Whether a timeout field holds whole seconds within its bounds; empty (null) is the default. */
const validTimeout = (value: number | null, bounds: { min: number; max: number }) =>
  value === null || (Number.isInteger(value) && value >= bounds.min && value <= bounds.max);

const keyCount = (rows: KeyValueRow[]) => rows.filter((r) => r.key.trim()).length;

export function McpForm({
  initial,
  agents,
  projects,
  secretNames,
  redirectUrl,
  oauth,
  toolCount = null,
}: {
  initial: McpFormValue;
  agents: PickerOption[];
  projects: PickerOption[];
  secretNames: string[];
  /** Callback URL to register in hand-made OAuth apps. */
  redirectUrl: string;
  oauth: McpOAuthStatus | null;
  /** Tools seen on the last successful connection; null until the first one. */
  toolCount?: number | null;
}) {
  const t = useTranslations("mcp.form");
  const tl = useTranslations("mcp.list");
  const tc = useTranslations("common.actions");
  const tr = useTranslations("mcp.testResult");
  const tOAuth = useTranslations("mcp.oauth");
  const ts = useTranslations("sandbox.mcp");
  const tn = useTranslations("sandbox.network");
  const te = useTranslations("errors");
  const tv = useTranslations("mcp.validation");
  const policySummary = usePolicySummary();
  const router = useRouter();
  const isNew = !initial.id;
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [transport, setTransport] = useState(initial.transport);
  const [url, setUrl] = useState(initial.url);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState(initial.args.join("\n"));
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(toRows(initial.env));
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(toRows(initial.headers));
  const [network, setNetwork] = useState(initial.network);
  const [sandboxed, setSandboxed] = useState(initial.sandboxed);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [routeRows, setRouteRows] = useState(toRouteRows(initial.credentialRoutes));
  const [connectTimeout, setConnectTimeout] = useState(initial.connectTimeoutSec);
  const [callTimeout, setCallTimeout] = useState(initial.callTimeoutSec);
  const [advancedOpen, setAdvancedOpen] = useState(initial.connectTimeoutSec !== null || initial.callTimeoutSec !== null);
  const [auth, setAuth] = useState(initial.auth);
  const [client, setClient] = useState<OAuthClientValue>({
    clientId: initial.oauthClientId,
    clientSecret: initial.oauthClientSecret,
    keepSecret: initial.oauthClientSecretHidden,
    scope: initial.oauthScope,
  });
  const [enabled, setEnabled] = useState(initial.enabled);
  const [global, setGlobal] = useState(initial.global);
  const [agentIds, setAgentIds] = useState(initial.agentIds);
  const [projectIds, setProjectIds] = useState(initial.projectIds);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [connecting, setConnecting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const detection = useMcpAuthDetection({ initialUrl: initial.url, transport, isNew, setAuth });

  const slugError = slug && !SLUG_RE.test(slug) ? t("slugInvalid") : null;
  const connectTimeoutError = validTimeout(connectTimeout, MCP_TIMEOUTS.connectSec)
    ? undefined
    : tv("connectTimeout", MCP_TIMEOUTS.connectSec);
  const callTimeoutError = validTimeout(callTimeout, MCP_TIMEOUTS.callSec)
    ? undefined
    : tv("callTimeout", MCP_TIMEOUTS.callSec);
  const invalid = Boolean(slugError || connectTimeoutError || callTimeoutError);
  const { dirty, markSaved } = useDirtySnapshot([
    name,
    slug,
    transport,
    url,
    command,
    argsText,
    envRows,
    headerRows,
    network,
    sandboxed,
    workspace,
    routeRows,
    connectTimeout,
    callTimeout,
    auth,
    client,
    enabled,
    global,
    agentIds,
    projectIds,
  ]);
  const oauthMode = transport === "http" && auth === "oauth";
  // Saving any of these drops the OAuth tokens on the server, so Connect waits for a save.
  // Same rule as the server: a client secret without a client id is not stored.
  const clientId = client.clientId.trim();
  // The secret as it would be saved: typed, kept hidden, or none.
  const clientSecret = client.clientSecret.trim() || (client.keepSecret ? KEEP_SECRET : null);
  const initialSecret = initial.oauthClientSecret || (initial.oauthClientSecretHidden ? KEEP_SECRET : null);
  const oauthChanged =
    transport !== initial.transport ||
    url.trim() !== initial.url.trim() ||
    auth !== initial.auth ||
    clientId !== initial.oauthClientId ||
    (clientId ? clientSecret : null) !== initialSecret ||
    client.scope.trim() !== initial.oauthScope;

  const args = argsText
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);

  const server = () => ({
    name,
    slug,
    transport,
    url: url.trim() || null,
    command: command.trim() || null,
    args,
    env: toRecord(envRows),
    headers: toRecord(headerRows),
    network,
    sandboxed,
    workspace,
    credentialRoutes: toRouteDrafts(routeRows),
    connectTimeoutSec: connectTimeout,
    callTimeoutSec: callTimeout,
    auth,
    oauthClientId: client.clientId.trim() || null,
    oauthClientSecret: clientSecret,
    oauthScope: client.scope.trim() || null,
  });

  /** Saves the form; returns the server id, or null after showing the error. */
  async function save(): Promise<string | null> {
    const input = { server: server(), enabled, global, agentIds, projectIds };
    const res = initial.id ? await updateMcpServer({ ...input, id: initial.id }) : await createMcpServer(input);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    markSaved();
    return res.data.id;
  }

  // OAuth servers that are new, not connected or losing their tokens go on to authorize right after saving.
  const willConnect = oauthMode && (isNew || oauthChanged || oauth?.state !== "connected");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (willConnect) return void connectOAuth();
    startTransition(async () => {
      const id = await save();
      if (!id) return;
      toast.success(isNew ? t("created") : t("saved"));
      if (isNew) router.push(`/mcp/${id}`);
      else router.refresh();
    });
  }

  /** Saves pending edits first (one step for the user), then sends the browser to the authorization page. */
  async function connectOAuth() {
    const mustSave = dirty || isNew;
    if (mustSave && (invalid || !formRef.current?.reportValidity())) return;
    setConnecting(true);
    let leaving = false;
    try {
      const id = mustSave ? await save() : initial.id!;
      if (!id) return;
      const res = await connectMcpOAuth({ id });
      if (res.ok) {
        leaving = true; // the spinner stays until the browser has left for the authorization page
        return window.location.assign(res.data.url);
      }
      toast.error(res.error);
      if (isNew) router.push(`/mcp/${id}`);
      else if (dirty) router.refresh();
    } catch {
      toast.error(te("unknown"));
    } finally {
      if (!leaving) setConnecting(false);
    }
  }

  function runTest(call: () => ReturnType<typeof testMcpById>) {
    startTest(async () => {
      setTestResult(null);
      const res = await call();
      if (!res.ok) return void toast.error(res.error);
      setTestResult(res.data);
      // The result sits further down the form; a toast confirms the outcome where the user is.
      if (res.data.ok) toast.success(tr("connected", { count: res.data.tools.length }));
      else toast.error(tr("failed"), { description: res.data.error ?? tr("unknownError") });
    });
  }

  const test = () =>
    runTest(() => testMcpDraft({ id: initial.id, server: { ...server(), name: name || "test", slug: slug || "test" } }));

  // Back from the authorization page: show the tools the new tokens give access to.
  useMcpOAuthReturn({ onConnected: () => initial.id && runTest(() => testMcpById({ id: initial.id! })) });

  function remove() {
    if (!initial.id) return;
    startDelete(async () => {
      const res = await deleteMcpServer({ id: initial.id! });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("deleted"));
      router.push("/mcp");
    });
  }

  const vaultLink = (chunks: React.ReactNode) => (
    <Link href="/settings/secrets" className="underline underline-offset-2">
      {chunks}
    </Link>
  );
  const secretsHint = t.rich("secretsHint", {
    ref: `{{secret:${t("refName")}}}`,
    code: (chunks) => <code className="font-mono">{chunks}</code>,
    link: vaultLink,
  });
  const createLink = (href: string) =>
    function RichLink(chunks: React.ReactNode) {
      return (
        <Link href={href} className="underline underline-offset-2">
          {chunks}
        </Link>
      );
    };

  // Nothing to save: the primary button only goes to the authorization page.
  const oauthState = isNew ? "disconnected" : (oauth?.state ?? "disconnected");
  const reconnecting = oauthState !== "disconnected";
  const submitLabel = willConnect
    ? dirty || isNew
      ? tOAuth(reconnecting ? "saveAndReconnect" : "saveAndConnect")
      : tOAuth(reconnecting ? "reconnect" : "connect")
    : tc("save");
  const busy = pending || connecting;
  const submitButton = (className?: string) => (
    <Button type="submit" disabled={busy || invalid} className={className}>
      {busy ? <Spinner /> : !willConnect ? <SaveIcon /> : reconnecting ? <RefreshCwIcon /> : <LogInIcon />}
      {submitLabel}
    </Button>
  );
  const cancelLink = isNew && (
    <Button type="button" variant="ghost" asChild>
      <Link href="/mcp">{tc("cancel")}</Link>
    </Button>
  );

  const status = (done: boolean): SummaryStatus => (done ? "done" : "todo");
  const statusLabel = (done: boolean) => (done ? t("complete") : t("incomplete"));
  const identityDone = Boolean(name.trim() && slug && !slugError);
  const trimmedUrl = url.trim();
  const target =
    transport === "http"
      ? trimmedUrl
        ? URL.canParse(trimmedUrl)
          ? new URL(trimmedUrl).host
          : trimmedUrl
        : t("urlMissing")
      : command.trim()
        ? [command.trim(), ...args].join(" ")
        : t("commandMissing");
  const connectionDone = transport === "http" ? Boolean(trimmedUrl) : Boolean(command.trim());
  const connectionSummary = `${transport === "http" ? t("transportHttp") : t("transportStdio")} · ${target}`;
  const authDone = !oauthMode || (oauthState === "connected" && !oauthChanged);
  const authSummary = oauthMode
    ? `${t("authOAuth")} · ${tOAuth(`status.${oauthState}`)}`
    : t("headerCount", { count: keyCount(headerRows) });
  const testSummary = testing
    ? t("connecting")
    : testResult
      ? testResult.ok
        ? tr("connected", { count: testResult.tools.length })
        : tr("failed")
      : toolCount != null
        ? t("lastSeen", { count: toolCount })
        : t("notTested");
  const routes = routeCount(routeRows);
  const sandboxSummary = sandboxed
    ? [
        workspace === "run" ? t("workspaceRun") : t("workspaceServer"),
        policySummary.network(network),
        ...(routes ? [t("credentialRoutes.count", { count: routes })] : []),
      ].join(" · ")
    : ts("outside");
  const advancedSummary = t("advancedSummary", {
    connect: connectTimeout ?? MCP_TIMEOUTS.connectSec.default,
    call: callTimeout ?? MCP_TIMEOUTS.callSec.default,
  });
  const assignmentSummary = global
    ? t("globalSummary")
    : `${tl("agents", { count: agentIds.length })} · ${tl("projects", { count: projectIds.length })}`;

  return (
    <FormPage
      ref={formRef}
      onSubmit={submit}
      guard={dirty && !pending && !deleting && !connecting}
      identity={{
        name: name.trim(),
        untitled: t("untitled"),
        subtitle: slug,
        subtitleClassName: "font-mono",
        media: (size) => <McpServerIcon transport={transport} size={size} />,
      }}
      summary={
        <SummaryList label={t("summaryLabel")}>
          <SummaryItem
            target={SECTIONS.identity}
            status={status(identityDone)}
            statusLabel={statusLabel(identityDone)}
            label={t("identityTitle")}
          >
            {!name.trim() ? t("nameMissing") : (slugError ?? null)}
          </SummaryItem>
          <SummaryItem
            target={SECTIONS.connection}
            status={status(connectionDone)}
            statusLabel={statusLabel(connectionDone)}
            label={t("connectionTitle")}
          >
            <span title={connectionSummary}>{connectionSummary}</span>
          </SummaryItem>
          {transport === "stdio" && (
            <SummaryItem target={SECTIONS.sandbox} status="info" label={ts("title")}>
              {sandboxSummary}
            </SummaryItem>
          )}
          {transport === "http" && (
            <SummaryItem
              target={SECTIONS.auth}
              status={status(authDone)}
              statusLabel={statusLabel(authDone)}
              label={t("authTitle")}
            >
              {authSummary}
            </SummaryItem>
          )}
          <SummaryItem
            target={SECTIONS.test}
            status={testResult && !testing ? status(testResult.ok) : "info"}
            statusLabel={testResult && !testing ? statusLabel(testResult.ok) : undefined}
            label={t("testTitle")}
          >
            {testSummary}
          </SummaryItem>
          <SummaryItem target={SECTIONS.assignment} status="info" label={t("assignmentTitle")}>
            {assignmentSummary}
          </SummaryItem>
          <SummaryItem target={SECTIONS.assignment} status="info" label={t("statusTitle")}>
            {enabled ? t("active") : t("inactive")}
          </SummaryItem>
        </SummaryList>
      }
      submit={submitButton}
      cancel={cancelLink}
      status={isNew ? undefined : dirty ? t("unsaved") : t("noChanges")}
    >
      <section
        id={SECTIONS.identity}
        aria-label={t("identityTitle")}
        className="mb-2 flex scroll-mt-20 items-center gap-4 sm:gap-5"
      >
        <McpServerIcon transport={transport} size="2xl" className="sm:size-20 sm:rounded-[1.25rem] sm:[&_svg]:size-10" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor="mcp-name" className="sr-only">
            {t("name")}
          </label>
          <input
            id="mcp-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value, 48));
            }}
            required
            autoComplete="off"
            placeholder={t("namePlaceholder")}
            className="-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-lg bg-transparent px-2 py-0.5 text-2xl font-semibold tracking-tight transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/50 focus-visible:bg-muted/60 sm:text-3xl"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
            <label htmlFor="mcp-slug" className="sr-only">
              {t("slug")}
            </label>
            <input
              id="mcp-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              size={Math.max(slug.length, 6)}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="slug"
              aria-invalid={Boolean(slugError)}
              aria-describedby="mcp-slug-hint"
              className="-ml-2 max-w-full min-w-0 rounded-lg bg-transparent px-2 py-1 font-mono text-sm text-muted-foreground transition-colors outline-none placeholder:text-muted-foreground/50 hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:text-foreground aria-invalid:text-destructive"
            />
            <span id="mcp-slug-hint" className={cn("text-xs", slugError ? "text-destructive" : "text-muted-foreground/80")}>
              {slugError ??
                t.rich("slugHint", {
                  name: `${(slug || "slug").replace(/[^a-zA-Z0-9]/g, "_")}__tool`,
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
            </span>
          </div>
        </div>
      </section>

      <FormSection
        id={SECTIONS.connection}
        icon={CableIcon}
        title={t("connectionTitle")}
        description={t("connectionDescription")}
      >
        <McpFormTransport
          transport={transport}
          onTransportChange={setTransport}
          url={url}
          onUrlChange={(value) => {
            setUrl(value);
            detection.trackUrl(value);
          }}
          onUrlCommit={(value) => void detection.detectAuth(value)}
          command={command}
          onCommandChange={setCommand}
          argsText={argsText}
          onArgsTextChange={setArgsText}
          envRows={envRows}
          onEnvRowsChange={setEnvRows}
          secretNames={secretNames}
          secretsHint={secretsHint}
        />
      </FormSection>

      {transport === "stdio" && (
        <FormSection id={SECTIONS.sandbox} icon={BoxesIcon} title={ts("title")} description={ts("description")}>
          <label
            htmlFor="mcp-sandboxed"
            className="flex cursor-pointer items-center gap-3 rounded-xl border bg-background/60 p-3 dark:bg-input/10"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{ts("sandboxed")}</span>
              <span className="text-xs text-muted-foreground">{ts("sandboxedHint")}</span>
            </span>
            <Switch id="mcp-sandboxed" checked={sandboxed} onCheckedChange={setSandboxed} />
          </label>
          {sandboxed ? (
            <>
              <FormSubsection title={t("workspaceLabel")} description={t("workspaceDescription")}>
                <OptionCards
                  name="mcp-workspace"
                  label={t("workspaceLabel")}
                  value={workspace}
                  onValueChange={setWorkspace}
                  options={[
                    {
                      value: "server",
                      icon: BoxIcon,
                      title: t("workspaceServer"),
                      description: t("workspaceServerHint"),
                    },
                    {
                      value: "run",
                      icon: FolderOpenIcon,
                      title: t("workspaceRun"),
                      description: t("workspaceRunHint"),
                    },
                  ]}
                />
              </FormSubsection>
              <FormSubsection title={tn("label")} description={tn("description")}>
                <NetworkPolicyEditor name="mcp-network" value={network} onChange={setNetwork} />
              </FormSubsection>
              <McpFormCredentialRoutes
                rows={routeRows}
                onChange={setRouteRows}
                secretNames={secretNames}
                secretsHint={secretsHint}
              />
            </>
          ) : (
            <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-pretty">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning"
                aria-hidden
              />
              {ts("unsandboxedWarning")}
            </p>
          )}
        </FormSection>
      )}

      {transport === "http" && (
        <FormSection
          id={SECTIONS.auth}
          icon={LockKeyholeIcon}
          title={t("authTitle")}
          description={t("authDescription")}
          action={
            detection.detecting && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" /> {t("detecting")}
              </span>
            )
          }
        >
          <McpFormAuth
            auth={auth}
            onAuthChange={setAuth}
            detection={detection}
            serverId={initial.id}
            serverName={initial.name}
            oauth={oauth}
            dirty={dirty || isNew}
            willConnect={willConnect}
            connecting={connecting}
            onConnect={() => void connectOAuth()}
            client={client}
            onClientChange={setClient}
            redirectUrl={redirectUrl}
            headerRows={headerRows}
            onHeaderRowsChange={setHeaderRows}
            secretNames={secretNames}
            secretsHint={secretsHint}
          />
        </FormSection>
      )}

      <McpFormTest
        id={SECTIONS.test}
        result={testResult}
        testing={testing}
        slug={slug}
        oauthMode={oauthMode}
        toolCount={toolCount}
        onTest={test}
      />

      <FormSectionCollapsible
        id={SECTIONS.advanced}
        icon={SlidersHorizontalIcon}
        title={t("advancedTitle")}
        summary={advancedSummary}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        <SettingsNumberField
          id="mcp-connect-timeout"
          nullable
          label={t("connectTimeout")}
          hint={t("connectTimeoutHint", { seconds: MCP_TIMEOUTS.connectSec.default })}
          value={connectTimeout}
          onChange={setConnectTimeout}
          placeholder={String(MCP_TIMEOUTS.connectSec.default)}
          min={MCP_TIMEOUTS.connectSec.min}
          max={MCP_TIMEOUTS.connectSec.max}
          unit={t("secondsUnit")}
          error={connectTimeoutError}
        />
        <SettingsNumberField
          id="mcp-call-timeout"
          nullable
          label={t("callTimeout")}
          hint={t("callTimeoutHint", { seconds: MCP_TIMEOUTS.callSec.default })}
          value={callTimeout}
          onChange={setCallTimeout}
          placeholder={String(MCP_TIMEOUTS.callSec.default)}
          min={MCP_TIMEOUTS.callSec.min}
          max={MCP_TIMEOUTS.callSec.max}
          unit={t("secondsUnit")}
          error={callTimeoutError}
        />
      </FormSectionCollapsible>

      <FormSection
        id={SECTIONS.assignment}
        icon={UsersRoundIcon}
        title={t("assignmentTitle")}
        description={t("assignmentDescription")}
      >
        <McpGlobalSwitch checked={global} onCheckedChange={setGlobal} />
        {global ? (
          <p className="text-sm text-pretty text-muted-foreground">{t("globalOn")}</p>
        ) : (
          <>
            <AssignmentChips
              title={t("agents")}
              items={agents}
              selected={agentIds}
              onChange={setAgentIds}
              empty={t.rich("noAgents", { link: createLink("/agents/new") })}
            />
            <AssignmentChips
              title={t("projects")}
              items={projects}
              selected={projectIds}
              onChange={setProjectIds}
              empty={t.rich("noProjects", { link: createLink("/projects/new") })}
            />
          </>
        )}
        <McpActiveSwitch checked={enabled} onCheckedChange={setEnabled} />
      </FormSection>

      {!isNew && (
        <DangerZoneCard
          id="mcp"
          title={t("deleteCardTitle")}
          description={t("deleteCardDescription")}
          confirmTitle={t("deleteTitle", { name: initial.name })}
          confirmDescription={t("deleteDescription")}
          deleting={deleting}
          onDelete={remove}
        />
      )}
    </FormPage>
  );
}

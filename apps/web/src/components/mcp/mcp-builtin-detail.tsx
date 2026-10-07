"use client";

import { builtinMcp, type BuiltinMcpKey } from "@abotica/core/mcp-builtins";
import type { NetworkPolicy } from "@abotica/core/sandbox-policy";
import { CableIcon, ExternalLinkIcon, KeyRoundIcon, SaveIcon, UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormPage } from "@/components/app/form-page";
import { FormSection } from "@/components/app/form-section";
import { SummaryItem, SummaryList } from "@/components/app/summary-rail";
import { usePolicySummary } from "@/components/sandbox/sandbox-policy-editor";
import type { PickerOption } from "@/components/skills/assignment-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { type McpTestResult, testMcpById, updateBuiltinMcpServer } from "@/server/actions/mcp";
import { AssignmentChips } from "./assignment-chips";
import { McpApiKeyDialog } from "./mcp-api-key-dialog";
import { McpFormTest } from "./mcp-form-test";
import { McpServerIcon } from "./mcp-server-icon";
import { McpActiveSwitch, McpGlobalSwitch } from "./mcp-switch-row";

export type McpBuiltinServer = {
  id: string;
  name: string;
  slug: string;
  builtin: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  network: NetworkPolicy;
  workspace: "server" | "run";
  enabled: boolean;
  global: boolean;
  agentIds: string[];
  projectIds: string[];
  /** Whether the optional API key is stored; null when the server takes none. */
  apiKey: boolean | null;
  /** Tools seen on the last successful connection; null until the first one. */
  tools: string[] | null;
};

const SECTIONS = {
  identity: "mcp-identity",
  connection: "mcp-connection",
  apiKey: "mcp-api-key",
  test: "mcp-test",
  assignment: "mcp-assignment",
} as const;

/**
 * Page of a bundled server: its connection follows the catalog and is shown read-only; the user
 * decides whether it is enabled, offered to every agent (or assigned) and its optional API key.
 */
export function McpBuiltinDetail({
  server,
  agents,
  projects,
}: {
  server: McpBuiltinServer;
  agents: PickerOption[];
  projects: PickerOption[];
}) {
  const t = useTranslations("mcp.form");
  const tl = useTranslations("mcp.list");
  const tb = useTranslations("mcp.builtin");
  const tk = useTranslations("mcp.apiKey");
  const tc = useTranslations("common.actions");
  const tr = useTranslations("mcp.testResult");
  const policySummary = usePolicySummary();
  const router = useRouter();
  const bundled = builtinMcp(server.builtin);
  const [enabled, setEnabled] = useState(server.enabled);
  const [global, setGlobal] = useState(server.global);
  const [agentIds, setAgentIds] = useState(server.agentIds);
  const [projectIds, setProjectIds] = useState(server.projectIds);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();

  const { dirty, markSaved } = useDirtySnapshot([enabled, global, agentIds, projectIds]);
  const description = bundled ? tb(bundled.key as BuiltinMcpKey) : null;
  const http = server.transport === "http";
  const commandLine = [server.command, ...server.args].filter(Boolean).join(" ");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await updateBuiltinMcpServer({ id: server.id, enabled, global, agentIds, projectIds });
      if (!res.ok) return void toast.error(res.error);
      markSaved();
      toast.success(t("saved"));
      router.refresh();
    });
  }

  function test() {
    startTest(async () => {
      setTestResult(null);
      const res = await testMcpById({ id: server.id });
      if (!res.ok) return void toast.error(res.error);
      setTestResult(res.data);
      if (res.data.ok) toast.success(tr("connected", { count: res.data.tools.length }));
      else toast.error(tr("failed"), { description: res.data.error ?? tr("unknownError") });
    });
  }

  const createLink = (href: string) =>
    function RichLink(chunks: React.ReactNode) {
      return (
        <Link href={href} className="underline underline-offset-2">
          {chunks}
        </Link>
      );
    };

  const toolCount = server.tools?.length ?? null;
  const testSummary = testing
    ? t("connecting")
    : testResult
      ? testResult.ok
        ? tr("connected", { count: testResult.tools.length })
        : tr("failed")
      : toolCount != null
        ? t("lastSeen", { count: toolCount })
        : t("notTested");
  const connectionSummary = http
    ? `${t("transportHttp")} · ${server.url && URL.canParse(server.url) ? new URL(server.url).host : (server.url ?? "")}`
    : `${t("transportStdio")} · ${t("workspaceRun")}`;
  const assignmentSummary = global
    ? t("globalSummary")
    : `${tl("agents", { count: agentIds.length })} · ${tl("projects", { count: projectIds.length })}`;
  const keySummary = server.apiKey ? tk("set") : tk("anonymous");

  const submitButton = (className?: string) => (
    <Button type="submit" disabled={pending} className={className}>
      {pending ? <Spinner /> : <SaveIcon />}
      {tc("save")}
    </Button>
  );

  return (
    <FormPage
      onSubmit={submit}
      guard={dirty && !pending}
      identity={{
        name: server.name,
        subtitle: t("builtinBadge"),
        media: (size) => <McpServerIcon transport={server.transport} builtin={server.builtin} size={size} />,
      }}
      summary={
        <SummaryList label={t("summaryLabel")}>
          <SummaryItem target={SECTIONS.connection} status="info" label={t("connectionTitle")}>
            <span title={connectionSummary}>{connectionSummary}</span>
          </SummaryItem>
          {server.apiKey !== null && (
            <SummaryItem target={SECTIONS.apiKey} status="info" label={tk("title")}>
              {keySummary}
            </SummaryItem>
          )}
          <SummaryItem
            target={SECTIONS.test}
            status={testResult && !testing ? (testResult.ok ? "done" : "todo") : "info"}
            statusLabel={testResult && !testing ? (testResult.ok ? t("complete") : t("incomplete")) : undefined}
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
      status={dirty ? t("unsaved") : t("noChanges")}
    >
      <section
        id={SECTIONS.identity}
        aria-labelledby="mcp-title"
        className="mb-2 flex scroll-mt-20 items-center gap-4 sm:gap-5"
      >
        <McpServerIcon
          transport={server.transport}
          builtin={server.builtin}
          size="2xl"
          className="sm:size-20 sm:rounded-[1.25rem] sm:[&_svg]:size-10"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 id="mcp-title" className="text-2xl font-semibold tracking-tight wrap-anywhere sm:text-3xl">
            {server.name}
          </h1>
          {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge variant="secondary" className="font-normal">
              {t("builtinBadge")}
            </Badge>
            {bundled && (
              <a
                href={bundled.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {t("docs")}
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            )}
          </div>
        </div>
      </section>

      <FormSection
        id={SECTIONS.connection}
        icon={CableIcon}
        title={t("connectionTitle")}
        description={t("builtinConnectionDescription")}
      >
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-y-3">
          <dt className="text-muted-foreground">{t("transport")}</dt>
          <dd className="mb-2 sm:mb-0">{http ? t("transportHttp") : t("transportStdio")}</dd>
          {http ? (
            <>
              <dt className="text-muted-foreground">{t("url")}</dt>
              <dd className="font-mono text-xs break-all sm:text-sm">{server.url}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">{t("command")}</dt>
              <dd className="mb-2 font-mono text-xs break-all sm:mb-0 sm:text-sm">{commandLine}</dd>
              <dt className="text-muted-foreground">{t("runsIn")}</dt>
              <dd className="mb-2 sm:mb-0">
                {server.workspace === "run" ? t("workspaceRun") : t("workspaceServer")}
                <span className="block text-xs text-pretty text-muted-foreground">
                  {server.workspace === "run" ? t("workspaceRunHint") : t("workspaceServerHint")}
                </span>
              </dd>
              <dt className="text-muted-foreground">{t("network")}</dt>
              <dd>{policySummary.network(server.network)}</dd>
            </>
          )}
        </dl>
      </FormSection>

      {bundled?.transport === "http" && (
        <FormSection
          id={SECTIONS.apiKey}
          icon={KeyRoundIcon}
          title={tk("title")}
          description={tk("description")}
          action={
            <McpApiKeyDialog
              serverId={server.id}
              name={server.name}
              secret={bundled.apiKeySecret}
              keySet={Boolean(server.apiKey)}
            >
              <Button type="button" variant="outline" size="sm">
                <KeyRoundIcon /> {server.apiKey ? tk("replace") : tk("add")}
              </Button>
            </McpApiKeyDialog>
          }
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge variant={server.apiKey ? "secondary" : "outline"} className="font-normal">
              {server.apiKey && <KeyRoundIcon aria-hidden />}
              {keySummary}
            </Badge>
            <p className="min-w-0 flex-1 basis-56 text-sm text-pretty text-muted-foreground">
              {server.apiKey
                ? tk.rich("setHint", {
                    secret: bundled.apiKeySecret,
                    code: (chunks) => <code className="font-mono">{chunks}</code>,
                  })
                : tk("anonymousHint")}
            </p>
          </div>
        </FormSection>
      )}

      <McpFormTest
        id={SECTIONS.test}
        result={testResult}
        testing={testing}
        slug={server.slug}
        oauthMode={false}
        toolCount={toolCount}
        cachedTools={server.tools ?? undefined}
        onTest={test}
      />

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
    </FormPage>
  );
}

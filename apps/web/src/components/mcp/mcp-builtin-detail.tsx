"use client";

import { builtinMcp, type BuiltinMcpKey } from "@abotica/core/mcp-builtins";
import type { NetworkPolicy } from "@abotica/core/sandbox-policy";
import { CableIcon, ExternalLinkIcon, KeyRoundIcon, SaveIcon } from "lucide-react";
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
import { testMcpById, updateBuiltinMcpServer } from "@/server/actions/mcp";
import { McpApiKeyDialog } from "./mcp-api-key-dialog";
import { type McpAssignment, McpAssignmentSection, McpAssignmentSummary } from "./mcp-assignment";
import { McpFormTest, McpTestSummaryItem, useMcpTest } from "./mcp-form-test";
import { McpServerIcon } from "./mcp-server-icon";

type McpBuiltinServer = McpAssignment & {
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
  const tb = useTranslations("mcp.builtin");
  const tk = useTranslations("mcp.apiKey");
  const tc = useTranslations("common.actions");
  const policySummary = usePolicySummary();
  const router = useRouter();
  const bundled = builtinMcp(server.builtin);
  const [assignment, setAssignment] = useState<McpAssignment>({
    enabled: server.enabled,
    global: server.global,
    agentIds: server.agentIds,
    projectIds: server.projectIds,
  });
  const connectionTest = useMcpTest();
  const [pending, startTransition] = useTransition();

  const { dirty, markSaved } = useDirtySnapshot(assignment);
  const description = bundled ? tb(bundled.key as BuiltinMcpKey) : null;
  const http = server.transport === "http";
  const commandLine = [server.command, ...server.args].filter(Boolean).join(" ");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await updateBuiltinMcpServer({ id: server.id, ...assignment });
      if (!res.ok) return void toast.error(res.error);
      markSaved();
      toast.success(t("saved"));
      router.refresh();
    });
  }

  const toolCount = server.tools?.length ?? null;
  const connectionSummary = http
    ? `${t("transportHttp")} · ${server.url && URL.canParse(server.url) ? new URL(server.url).host : (server.url ?? "")}`
    : `${t("transportStdio")} · ${t("workspaceRun")}`;
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
          <McpTestSummaryItem
            target={SECTIONS.test}
            result={connectionTest.result}
            testing={connectionTest.testing}
            toolCount={toolCount}
          />
          <McpAssignmentSummary target={SECTIONS.assignment} value={assignment} />
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
        <McpServerIcon transport={server.transport} builtin={server.builtin} size="2xl" />
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
        result={connectionTest.result}
        testing={connectionTest.testing}
        slug={server.slug}
        oauthMode={false}
        toolCount={toolCount}
        cachedTools={server.tools ?? undefined}
        onTest={() => connectionTest.run(() => testMcpById({ id: server.id }))}
      />

      <McpAssignmentSection
        id={SECTIONS.assignment}
        value={assignment}
        onChange={setAssignment}
        agents={agents}
        projects={projects}
      />
    </FormPage>
  );
}

import { createHash } from "node:crypto";
import { mcpOAuthRedirectUrl } from "@abotica/core";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageBody } from "@/components/app/page-header";
import { McpBuiltinDetail } from "@/components/mcp/mcp-builtin-detail";
import { McpForm } from "@/components/mcp/mcp-form";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/uuid";
import { getMcpServer, getMcpServerDetail, listSecretNames } from "@/server/queries/mcp";
import { getAssignTargets } from "@/server/queries/skills";
import { requestOrigin } from "@/server/request-origin";

/**
 * Remounts a form only when the values it edits change (after a save or an edit elsewhere). Keying on
 * updatedAt would also remount it when the worker caches the tool list, dropping unsaved edits.
 */
const formKey = (values: object) => createHash("sha256").update(JSON.stringify(values)).digest("base64url");

export async function generateMetadata(props: PageProps<"/mcp/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const server = isUuid(id) ? await getMcpServer(id) : null;
  const t = await getTranslations("mcp.meta");
  return { title: server ? t("detail", { name: server.name }) : t("fallback") };
}

export default async function McpServerPage(props: PageProps<"/mcp/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const [server, targets, secretNames, t] = await Promise.all([
    getMcpServerDetail(id),
    getAssignTargets(),
    listSecretNames(),
    getTranslations("mcp.form"),
  ]);
  if (!server) notFound();
  const back = (
    <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
      <Link href="/mcp">
        <ArrowLeftIcon /> {t("back")}
      </Link>
    </Button>
  );
  if (server.builtin) {
    const values = {
      id: server.id,
      name: server.name,
      slug: server.slug,
      builtin: server.builtin,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      network: server.network,
      workspace: server.workspace,
      enabled: server.enabled,
      global: server.global,
      agentIds: server.agentIds,
      projectIds: server.projectIds,
      apiKey: server.apiKey,
    };
    return (
      <PageBody>
        {back}
        <McpBuiltinDetail
          key={formKey(values)}
          server={{ ...values, tools: server.tools?.map((tool) => tool.name).sort() ?? null }}
          agents={targets.agents}
          projects={targets.projects}
        />
      </PageBody>
    );
  }
  const initial = {
    id: server.id,
    name: server.name,
    slug: server.slug,
    transport: server.transport,
    url: server.url ?? "",
    command: server.command ?? "",
    args: server.args,
    env: server.env,
    headers: server.headers,
    network: server.network,
    sandboxed: server.sandboxed,
    workspace: server.workspace,
    credentialRoutes: server.credentialRoutes,
    auth: server.auth,
    oauthClientId: server.oauthClientId ?? "",
    oauthClientSecret: server.oauthClientSecret ?? "",
    oauthClientSecretHidden: server.hasOAuthClientSecret && server.oauthClientSecret === null,
    oauthScope: server.oauthScope ?? "",
    enabled: server.enabled,
    global: server.global,
    agentIds: server.agentIds,
    projectIds: server.projectIds,
  };
  return (
    <PageBody>
      {back}
      {/* The server name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{server.name}</h1>
      <McpForm
        key={formKey(initial)}
        initial={initial}
        agents={targets.agents}
        projects={targets.projects}
        secretNames={secretNames}
        redirectUrl={mcpOAuthRedirectUrl(await requestOrigin())}
        oauth={server.oauth}
        toolCount={server.tools?.length ?? null}
      />
    </PageBody>
  );
}

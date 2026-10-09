import { DEFAULT_MCP_NETWORK, mcpOAuthRedirectUrl } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BackLink } from "@/components/app/back-link";
import { PageBody } from "@/components/app/page-header";
import { McpForm } from "@/components/mcp/mcp-form";
import { listSecretNames } from "@/server/queries/mcp";
import { getAssignTargets } from "@/server/queries/skills";
import { requestOrigin } from "@/server/request-origin";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mcp.meta");
  return { title: t("new") };
}

export default async function NewMcpPage() {
  const [targets, secretNames, t] = await Promise.all([getAssignTargets(), listSecretNames(), getTranslations("mcp.form")]);
  return (
    <PageBody>
      <BackLink href="/mcp">{t("back")}</BackLink>
      {/* The server name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{t("newTitle")}</h1>
      <McpForm
        initial={{
          name: "",
          slug: "",
          transport: "http",
          url: "",
          command: "",
          args: [],
          env: {},
          headers: {},
          network: DEFAULT_MCP_NETWORK,
          sandboxed: true,
          workspace: "server",
          credentialRoutes: [],
          connectTimeoutSec: null,
          callTimeoutSec: null,
          auth: "headers",
          oauthClientId: "",
          oauthClientSecret: "",
          oauthClientSecretHidden: false,
          oauthScope: "",
          enabled: true,
          global: false,
          agentIds: [],
          projectIds: [],
        }}
        agents={targets.agents}
        projects={targets.projects}
        secretNames={secretNames}
        redirectUrl={mcpOAuthRedirectUrl(await requestOrigin())}
        oauth={null}
      />
    </PageBody>
  );
}

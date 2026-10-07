import { abortMcpOAuth, audit, finishMcpOAuth, McpOAuthCallbackError, pendingMcpOAuth } from "@abotica/core";
import { type NextRequest, NextResponse } from "next/server";
import { getMcpServer } from "@/server/queries/mcp";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

type Outcome = "connected" | "denied" | "expired" | "failed";

/** Where the authorization server sends the user back after Connect on an MCP server. */
export async function GET(request: NextRequest) {
  await requireUser();
  const params = request.nextUrl.searchParams;
  // Back to the address the authorization started from (a tunnel may present itself as localhost here).
  let origin = request.nextUrl.origin;
  const back = (outcome: Outcome, serverId?: string, message?: string) => {
    const url = new URL(serverId ? `/mcp/${serverId}` : "/mcp", origin);
    url.searchParams.set("oauth", outcome);
    if (message) url.searchParams.set("message", message.slice(0, 300));
    return NextResponse.redirect(url);
  };

  const state = params.get("state");
  if (!state) return back("expired");
  let serverId: string;
  try {
    const pending = await pendingMcpOAuth(state);
    serverId = pending.serverId;
    origin = pending.origin ?? origin;
  } catch (error) {
    if (error instanceof McpOAuthCallbackError) return back(error.reason, error.serverId);
    throw error;
  }

  const denied = params.get("error");
  if (denied) {
    await abortMcpOAuth(serverId);
    const outcome = denied === "access_denied" ? "denied" : "failed";
    return back(outcome, serverId, params.get("error_description") ?? (outcome === "failed" ? denied : undefined));
  }

  const code = params.get("code");
  const server = await getMcpServer(serverId);
  if (!server || !code) {
    await abortMcpOAuth(serverId);
    return back("failed", server?.id);
  }
  try {
    await finishMcpOAuth(server, { code, state, issuer: params.get("iss") ?? undefined });
  } catch (error) {
    if (error instanceof McpOAuthCallbackError) return back(error.reason, serverId, error.message);
    throw error;
  }
  await audit({
    actor: "user",
    action: "mcp.connected",
    entityType: "mcp_server",
    entityId: serverId,
    data: { slug: server.slug },
  });
  return back("connected", serverId);
}

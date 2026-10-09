"use client";

import {
  builtinPermission,
  mcpServerKey,
  mcpServerPermission,
  mcpToolKey,
  mcpToolPermission,
  type PermissionSubject,
  toolAvailableTo,
  type ToolPermission,
  type ToolPermissions,
} from "@abotica/core/agents/permissions";
import { TOOL_CATALOG, type ToolInfo } from "@abotica/core/agents/tools/tool-catalog";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection, FormSubsection } from "@/components/app/form-section";
import { TOOL_GROUP_ICONS } from "@/components/app/tool-group-icons";
import { McpServerIcon } from "@/components/mcp/mcp-server-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { syncMcpTools } from "@/server/actions/mcp";
import type { AgentFormOptions } from "@/server/queries/agents";
import { common, withAllAllowed, withMcpTool } from "./mcp-permission-values";
import { PermissionControl } from "./permission-control";

type McpServer = AgentFormOptions["mcpServers"][number];
type Update = (fn: (prev: ToolPermissions) => ToolPermissions) => void;

const GROUPS: ToolInfo["group"][] = ["memory", "tasks", "web", "workspace", "orchestration"];

/** Built-in tools the agent can have: the super agent's own are out of reach, except the manager tools for a manager. */
const toolsFor = (subject: PermissionSubject) => TOOL_CATALOG.filter((tool) => toolAvailableTo(tool, subject));

const withBuiltin = (perms: ToolPermissions, tool: ToolInfo, permission: ToolPermission): ToolPermissions => ({
  ...perms,
  [tool.name]: permission,
});

/** Sets a server's permission and drops its per-tool choices; null removes the server's entry too. */
function withServer(perms: ToolPermissions, slug: string, permission: ToolPermission | null): ToolPermissions {
  const prefix = mcpToolKey(slug, "");
  const next = Object.fromEntries(Object.entries(perms).filter(([key]) => !key.startsWith(prefix)));
  if (permission) next[mcpServerKey(slug)] = permission;
  else delete next[mcpServerKey(slug)];
  return next;
}

/**
 * Integrations the agent gets: the global ones (offered to every agent, never stored as an assignment)
 * first, then the ones assigned to it.
 */
const offeredServers = (servers: McpServer[], mcpServerIds: string[]) =>
  servers.filter((s) => s.global || mcpServerIds.includes(s.id)).sort((a, b) => Number(b.global) - Number(a.global));

/** Choices that hold something back (ask first or off); every tool runs on its own without one. */
export const restrictionCount = (permissions: ToolPermissions) =>
  Object.values(permissions).filter((p) => p !== "allow").length;

/**
 * The "Tools" form section: everything is on, so the main view is the integrations the agent uses; the
 * per-tool control (ask first or off, built-in tools and integration tools) sits under a disclosure.
 */
export function AgentToolsSection({
  id,
  permissions,
  setPermissions,
  mcpServerIds,
  setMcpServerIds,
  servers: initialServers,
  subject,
}: {
  /** Section id, the scroll target of the form summary. */
  id: string;
  permissions: ToolPermissions;
  setPermissions: Update;
  mcpServerIds: string[];
  setMcpServerIds: (ids: string[]) => void;
  servers: McpServer[];
  /** The super agent, a manager (it gets the manager tools) or a specialist. */
  subject: PermissionSubject;
}) {
  const t = useTranslations("agents.tools");
  // Local copy so freshly loaded tool lists show up without a page refresh.
  const [servers, setServers] = useState(initialServers);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const offered = offeredServers(servers, mcpServerIds);
  const unassigned = servers.filter((s) => !offered.includes(s));
  const restricted = restrictionCount(permissions);
  const link = (chunks: React.ReactNode) => (
    <Link href="/mcp" className="underline underline-offset-2">
      {chunks}
    </Link>
  );

  return (
    <FormSection id={id} icon={WrenchIcon} title={t("title")} description={t("description")}>
      <FormSubsection
        title={t("integrations")}
        count={offered.length}
        action={
          unassigned.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <PlusIcon data-icon="inline-start" />
                  {t("add")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto max-w-80 min-w-56">
                {unassigned.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => setMcpServerIds([...mcpServerIds, s.id])}
                    className="min-h-8"
                  >
                    <McpServerIcon transport={s.transport} builtin={s.builtin} size="md" />
                    <span className="min-w-0 truncate">{s.name}</span>
                    {!s.enabled && (
                      <Badge variant="outline" className="ml-auto font-normal">
                        {t("disabled")}
                      </Badge>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      >
        {offered.length ? (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-input/10">
            {offered.map((server) => {
              const off = permissions[mcpServerKey(server.slug)] === "deny";
              return (
                <li key={server.id} className="flex min-h-12 items-center gap-3 py-2 pr-2 pl-3">
                  <McpServerIcon transport={server.transport} builtin={server.builtin} size="md" />
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Link
                      href={`/mcp/${server.id}`}
                      className="max-w-full truncate text-sm font-medium underline-offset-2 hover:underline"
                      title={server.name}
                    >
                      {server.name}
                    </Link>
                    {server.global && (
                      <Badge variant="secondary" className="font-normal">
                        {t("allAgents")}
                      </Badge>
                    )}
                    {!server.enabled && (
                      <Badge variant="outline" className="font-normal">
                        {t("disabled")}
                      </Badge>
                    )}
                    {off && (
                      <Badge variant="outline" className="font-normal">
                        {t("offForAgent")}
                      </Badge>
                    )}
                  </span>
                  {/* A global integration reaches every agent: it is turned off for one under Advanced. */}
                  {!server.global && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setMcpServerIds(mcpServerIds.filter((sid) => sid !== server.id));
                        setPermissions((prev) => withServer(prev, server.slug, null));
                      }}
                      aria-label={t("remove", { name: server.name })}
                      title={t("remove", { name: server.name })}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <XIcon />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{servers.length ? t("none") : t.rich("noRegistry", { link })}</p>
        )}
      </FormSubsection>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="rounded-xl border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/advanced flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:rounded-b-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t("advancedTitle")}</span>
              <span className="block text-xs text-muted-foreground">{t("restricted", { count: restricted })}</span>
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/advanced:rotate-180"
              aria-hidden
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 border-t p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-pretty text-muted-foreground">{t("advancedDescription")}</p>
            {restricted > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPermissions(withAllAllowed)}>
                <RotateCcwIcon data-icon="inline-start" />
                {t("reset")}
              </Button>
            )}
          </div>
          <ToolControls
            permissions={permissions}
            setPermissions={setPermissions}
            subject={subject}
            offered={offered}
            onToolsLoaded={(sid, list, syncedAt) =>
              setServers((prev) => prev.map((s) => (s.id === sid ? { ...s, tools: list, toolsSyncedAt: syncedAt } : s)))
            }
          />
        </CollapsibleContent>
      </Collapsible>
    </FormSection>
  );
}

/** One collapsible group per built-in tool group and per integration, each tool with its own control. */
function ToolControls({
  permissions,
  setPermissions,
  subject,
  offered,
  onToolsLoaded,
}: {
  permissions: ToolPermissions;
  setPermissions: Update;
  subject: PermissionSubject;
  offered: McpServer[];
  onToolsLoaded: (id: string, tools: McpServer["tools"], syncedAt: Date) => void;
}) {
  const t = useTranslations("agents.tools");
  const tt = useTranslations("tools");
  const tools = toolsFor(subject);
  const toolText = (tool: ToolInfo, field: "label" | "description") => {
    const key = `${tool.name}.${field}` as Parameters<typeof tt>[0];
    return tt.has(key) ? tt(key) : tool[field];
  };

  return (
    <div className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-input/10">
      {GROUPS.map((g) => {
        const list = tools.filter((tool) => tool.group === g);
        if (!list.length) return null;
        const name = tt(`groups.${g}`);
        const values = list.map((tool) => builtinPermission(permissions, tool.name, subject));
        return (
          <ToolGroup
            key={g}
            media={<GroupIcon icon={TOOL_GROUP_ICONS[g]} />}
            title={name}
            control={
              <PermissionControl
                value={common(values)}
                onChange={(p) => setPermissions((prev) => list.reduce((acc, tool) => withBuiltin(acc, tool, p), prev))}
                label={t("groupControlFor", { group: name })}
              />
            }
          >
            {list.map((tool) => {
              const label = toolText(tool, "label");
              return (
                <ToolRow key={tool.name} label={label} description={toolText(tool, "description")}>
                  <PermissionControl
                    value={builtinPermission(permissions, tool.name, subject)}
                    onChange={(p) => setPermissions((prev) => withBuiltin(prev, tool, p))}
                    label={t("controlFor", { name: label })}
                  />
                </ToolRow>
              );
            })}
          </ToolGroup>
        );
      })}
      {offered.map((server) => (
        <IntegrationTools
          key={server.id}
          server={server}
          permissions={permissions}
          setPermissions={setPermissions}
          onToolsLoaded={(list, syncedAt) => onToolsLoaded(server.id, list, syncedAt)}
        />
      ))}
    </div>
  );
}

function IntegrationTools({
  server,
  permissions,
  setPermissions,
  onToolsLoaded,
}: {
  server: McpServer;
  permissions: ToolPermissions;
  setPermissions: Update;
  onToolsLoaded: (tools: McpServer["tools"], syncedAt: Date) => void;
}) {
  const t = useTranslations("agents.tools");
  const [loading, startLoading] = useTransition();
  const tools = server.tools ?? [];

  function load() {
    startLoading(async () => {
      const res = await syncMcpTools(server.id);
      if (!res.ok) return void toast.error(res.error);
      onToolsLoaded(res.data.tools, res.data.syncedAt);
      toast.success(t("toolsLoaded", { count: res.data.tools.length }));
    });
  }

  return (
    <ToolGroup
      media={
        <McpServerIcon
          transport={server.transport}
          builtin={server.builtin}
          size="md"
          className="size-5 rounded-md [&_svg]:size-3"
        />
      }
      title={server.name}
      control={
        <PermissionControl
          value={mcpServerPermission(permissions, server.slug)}
          onChange={(p) => setPermissions((prev) => withServer(prev, server.slug, p))}
          label={t("controlFor", { name: server.name })}
        />
      }
    >
      {tools.map((tool) => (
        <ToolRow key={tool.name} label={tool.name} mono description={tool.description}>
          <PermissionControl
            value={mcpToolPermission(permissions, server.slug, tool.name)}
            onChange={(p) => setPermissions((prev) => withMcpTool(prev, server, tool, p))}
            label={t("controlFor", { name: tool.name })}
          />
        </ToolRow>
      ))}
      <div className="flex items-center justify-between gap-3 py-1.5 pr-2 pl-3 sm:pl-9">
        <p className="min-w-0 text-xs text-muted-foreground">
          {server.tools === null ? t("toolsNotLoaded") : tools.length ? null : t("noTools")}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={load} disabled={loading} className="text-xs">
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {server.tools === null ? t("loadTools") : t("reloadTools")}
        </Button>
      </div>
    </ToolGroup>
  );
}

/** A group (built-in or integration): one header line with its control; the tool rows show when opened. */
function GroupIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function ToolGroup({
  media,
  title,
  control,
  children,
}: {
  media: React.ReactNode;
  title: string;
  control: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 py-1.5 pr-2 pl-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/trigger flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/trigger:rotate-90"
              aria-hidden
            />
            {media}
            <span className="min-w-0 truncate text-sm font-medium" title={title}>
              {title}
            </span>
          </button>
        </CollapsibleTrigger>
        {control}
      </div>
      <CollapsibleContent className="divide-y border-t bg-muted/20">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** One dense line: name and description (clamped) on the left, the compact control on the right. */
function ToolRow({
  label,
  description,
  mono,
  children,
}: {
  label: string;
  description?: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 pr-2 pl-3 sm:pl-9">
      <div className="min-w-0 flex-1">
        <p className={mono ? "truncate font-mono text-xs font-medium" : "truncate text-sm font-medium"} title={label}>
          {label}
        </p>
        {description && (
          <p className="truncate text-xs text-muted-foreground" title={description}>
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

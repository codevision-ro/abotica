"use client";

import {
  builtinPermission,
  clampPermission,
  MCP_ALL_KEY,
  type McpToolHint,
  mcpServerKey,
  mcpToolDefault,
  mcpToolHint,
  mcpToolKey,
  mcpToolPermission,
  type PermissionSubject,
  TOOL_PERMISSIONS,
  type ToolPermission,
  type ToolPermissions,
} from "@abotica/core/agents/permissions";
import { TOOL_CATALOG, type ToolInfo } from "@abotica/core/agents/tools/tool-catalog";
import { builtinMcp } from "@abotica/core/mcp-builtins";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection, FormSubsection } from "@/components/app/form-section";
import { RelativeTime } from "@/components/app/relative-time";
import { TOOL_GROUP_ICONS } from "@/components/app/tool-group-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { syncMcpTools } from "@/server/actions/mcp";
import type { AgentFormOptions } from "@/server/queries/agents";
import { common, mcpDefaultValue, mcpServerValue, withMcpDefault, withMcpTool } from "./mcp-permission-values";
import { PERMISSION_ICONS, PERMISSION_TEXT, PermissionControl } from "./permission-control";

type McpServer = AgentFormOptions["mcpServers"][number];
type Update = (fn: (prev: ToolPermissions) => ToolPermissions) => void;

const GROUPS: ToolInfo["group"][] = ["memory", "tasks", "web", "workspace", "orchestration"];

/** Built-in tools the agent has: the super agent's own are out of reach, except the manager tools for a manager. */
const toolsFor = ({ kind }: PermissionSubject) =>
  TOOL_CATALOG.filter((tool) => kind === "orchestrator" || !tool.orchestratorOnly || (tool.managers && kind === "manager"));

/** A manager's manager tool: without an entry it gets its default, so "deny" is stored. */
const isManagerTool = (tool: ToolInfo, kind: PermissionSubject["kind"]) => Boolean(tool.managers) && kind === "manager";

/** Built-in denials are stored as absence, like the server sanitizes them; a manager tool keeps "deny". */
function withBuiltin(
  perms: ToolPermissions,
  tool: ToolInfo,
  permission: ToolPermission,
  kind: PermissionSubject["kind"],
): ToolPermissions {
  const next = { ...perms };
  const value = clampPermission(tool, permission);
  if (value === "deny" && !isManagerTool(tool, kind)) delete next[tool.name];
  else next[tool.name] = value;
  return next;
}

/** Sets a server's permission and drops its per-tool overrides. */
function withServer(perms: ToolPermissions, slug: string, permission: ToolPermission | null): ToolPermissions {
  const prefix = mcpToolKey(slug, "");
  const next = Object.fromEntries(Object.entries(perms).filter(([key]) => !key.startsWith(prefix)));
  if (permission) next[mcpServerKey(slug)] = permission;
  else delete next[mcpServerKey(slug)];
  return next;
}

/**
 * Servers the agent gets: the global ones (offered to every agent, never stored as an assignment)
 * first, then the ones assigned to it.
 */
const offeredServers = (servers: McpServer[], mcpServerIds: string[]) =>
  servers.filter((s) => s.global || mcpServerIds.includes(s.id)).sort((a, b) => Number(b.global) - Number(a.global));

/** Message key under `agents.permissions` for what a tool declares about itself. */
const HINT_KEYS = {
  readOnly: "hintReadOnly",
  nonDestructive: "hintNonDestructive",
  destructive: "hintDestructive",
  none: "hintNone",
} as const satisfies Record<McpToolHint, string>;

/** Effective permission of every tool the agent has: built-in ones plus loaded tools of its MCP servers. */
export function effectivePermissions(
  permissions: ToolPermissions,
  { subject, servers, mcpServerIds }: { subject: PermissionSubject; servers: McpServer[]; mcpServerIds: string[] },
): ToolPermission[] {
  const builtin = toolsFor(subject).map((tool) => builtinPermission(permissions, tool.name, subject));
  const mcp = offeredServers(servers, mcpServerIds).flatMap((s) =>
    (s.tools ?? []).map((tool) =>
      mcpToolPermission(permissions, s.slug, tool.name, mcpToolDefault(tool.annotations, s.builtin)),
    ),
  );
  return [...builtin, ...mcp];
}

/** The "Tools and permissions" form section: built-in tools by group and the agent's MCP servers. */
export function PermissionsEditor({
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
  const { kind } = subject;
  const t = useTranslations("agents.permissions");
  const tt = useTranslations("tools");
  // Local copy so freshly loaded tool lists show up without a page refresh.
  const [servers, setServers] = useState(initialServers);
  const tools = toolsFor(subject);
  const offered = offeredServers(servers, mcpServerIds);
  const toolText = (tool: ToolInfo, field: "label" | "description") => {
    const key = `${tool.name}.${field}` as Parameters<typeof tt>[0];
    return tt.has(key) ? tt(key) : tool[field];
  };

  function setAll(permission: ToolPermission) {
    setPermissions((prev) => {
      let next = prev;
      for (const tool of tools) next = withBuiltin(next, tool, permission, kind);
      for (const server of offered) next = withServer(next, server.slug, permission);
      return next;
    });
  }

  return (
    <FormSection
      id={id}
      icon={ShieldCheckIcon}
      title={t("title")}
      description={t("description")}
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {t("setAll")}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto max-w-72">
            <DropdownMenuLabel className="whitespace-normal">{t("setAllHint")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {TOOL_PERMISSIONS.map((p) => {
              const Icon = PERMISSION_ICONS[p];
              return (
                <DropdownMenuItem key={p} onSelect={() => setAll(p)} className="min-h-8">
                  <Icon className={PERMISSION_TEXT[p]} />
                  {t(`setAllOptions.${p}`)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <FormSubsection title={t("builtinTitle")}>
        <div className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-input/10">
          {GROUPS.map((g) => {
            const list = tools.filter((tool) => tool.group === g);
            if (!list.length) return null;
            const group = tt(`groups.${g}`);
            // For a manager this group holds only the manager tools.
            const name =
              g === "orchestration"
                ? kind === "orchestrator"
                  ? t("orchestratorGroup", { group })
                  : t("managerGroup", { group })
                : group;
            const values = list.map((tool) => builtinPermission(permissions, tool.name, subject));
            return (
              <PermissionGroup
                key={g}
                icon={TOOL_GROUP_ICONS[g]}
                title={name}
                values={values}
                control={
                  <PermissionControl
                    value={common(values)}
                    onChange={(p) =>
                      setPermissions((prev) => list.reduce((acc, tool) => withBuiltin(acc, tool, p, kind), prev))
                    }
                    label={t("groupControlFor", { group: name })}
                  />
                }
              >
                {list.map((tool) => {
                  const label = toolText(tool, "label");
                  return (
                    <ToolRow
                      key={tool.name}
                      label={label}
                      name={tool.name}
                      description={toolText(tool, "description")}
                      note={tool.alwaysAsk ? t("alwaysAsk") : undefined}
                    >
                      <PermissionControl
                        value={builtinPermission(permissions, tool.name, subject)}
                        onChange={(p) => setPermissions((prev) => withBuiltin(prev, tool, p, kind))}
                        label={t("controlFor", { name: label })}
                        disabled={tool.alwaysAsk ? ["allow"] : undefined}
                      />
                    </ToolRow>
                  );
                })}
              </PermissionGroup>
            );
          })}
        </div>
      </FormSubsection>

      <McpSection
        permissions={permissions}
        setPermissions={setPermissions}
        servers={servers}
        offered={offered}
        onAssign={(id) => setMcpServerIds([...mcpServerIds, id])}
        onRemove={(server) => {
          setMcpServerIds(mcpServerIds.filter((id) => id !== server.id));
          setPermissions((prev) => withServer(prev, server.slug, null));
        }}
        onToolsLoaded={(id, list, syncedAt) =>
          setServers((prev) => prev.map((s) => (s.id === id ? { ...s, tools: list, toolsSyncedAt: syncedAt } : s)))
        }
      />
    </FormSection>
  );
}

function McpSection({
  permissions,
  setPermissions,
  servers,
  offered,
  onAssign,
  onRemove,
  onToolsLoaded,
}: {
  permissions: ToolPermissions;
  setPermissions: Update;
  servers: McpServer[];
  /** Global servers and the ones assigned to the agent. */
  offered: McpServer[];
  onAssign: (id: string) => void;
  onRemove: (server: McpServer) => void;
  onToolsLoaded: (id: string, tools: McpServer["tools"], syncedAt: Date) => void;
}) {
  const t = useTranslations("agents.permissions");
  const unassigned = servers.filter((s) => !offered.includes(s));

  // Without any server in the registry the default has nothing to apply to: one line with the way forward.
  if (servers.length === 0) {
    return (
      <FormSubsection title={t("mcpTitle")}>
        <p className="text-xs text-muted-foreground">
          {t.rich("noRegistry", {
            link: (chunks) => (
              <Link href="/mcp" className="underline underline-offset-2">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </FormSubsection>
    );
  }

  return (
    <FormSubsection title={t("mcpTitle")} description={t("mcpDescription")}>
      <div className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-input/10">
        <div className="flex items-center gap-2 bg-muted/40 py-1.5 pr-2 pl-3">
          <ServerIcon className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("mcpDefault")}</p>
            {permissions[MCP_ALL_KEY] ? (
              <Button
                type="button"
                variant="link"
                onClick={() => setPermissions((prev) => withMcpDefault(prev, null))}
                className="h-auto p-0 text-xs font-normal text-muted-foreground"
              >
                {t("useHints")}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t("mcpDefaultFromHints")}</p>
            )}
          </div>
          <PermissionControl
            value={mcpDefaultValue(permissions, offered)}
            onChange={(p) => setPermissions((prev) => withMcpDefault(prev, p))}
            label={t("mcpDefault")}
          />
        </div>
        {offered.map((server) => (
          <McpServerGroup
            key={server.id}
            server={server}
            permissions={permissions}
            setPermissions={setPermissions}
            onRemove={() => onRemove(server)}
            onToolsLoaded={(list, syncedAt) => onToolsLoaded(server.id, list, syncedAt)}
          />
        ))}
      </div>

      {!offered.length && <p className="text-xs text-muted-foreground">{t("noServersAssigned")}</p>}
      {unassigned.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="self-start">
              <PlusIcon data-icon="inline-start" />
              {t("addServer")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto max-w-80 min-w-56">
            {unassigned.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => onAssign(s.id)} className="min-h-8">
                <ServerIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{s.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{s.slug}</span>
                </span>
                {!s.enabled && (
                  <Badge variant="outline" className="ml-auto">
                    {t("disabled")}
                  </Badge>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </FormSubsection>
  );
}

function McpServerGroup({
  server,
  permissions,
  setPermissions,
  onRemove,
  onToolsLoaded,
}: {
  server: McpServer;
  permissions: ToolPermissions;
  setPermissions: Update;
  onRemove: () => void;
  onToolsLoaded: (tools: McpServer["tools"], syncedAt: Date) => void;
}) {
  const t = useTranslations("agents.permissions");
  const [loading, startLoading] = useTransition();
  const prefix = mcpToolKey(server.slug, "");
  const overrides = Object.keys(permissions).filter((key) => key.startsWith(prefix)).length;
  const rows = (server.tools ?? []).map((tool) => ({
    tool,
    value: mcpToolPermission(permissions, server.slug, tool.name, mcpToolDefault(tool.annotations, server.builtin)),
  }));
  const values = rows.map((row) => row.value);
  const serverValue = mcpServerValue(permissions, server);

  function load() {
    startLoading(async () => {
      const res = await syncMcpTools(server.id);
      if (!res.ok) return void toast.error(res.error);
      onToolsLoaded(res.data.tools, res.data.syncedAt);
      toast.success(t("toolsLoaded", { count: res.data.tools.length }));
    });
  }

  const loadIcon = loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />;

  return (
    <PermissionGroup
      title={server.name}
      values={values}
      badges={
        <>
          {server.builtin && <Badge variant="secondary">{t("builtinBadge")}</Badge>}
          {server.global && <Badge variant="secondary">{t("globalBadge")}</Badge>}
          {!server.enabled && <Badge variant="outline">{t("disabled")}</Badge>}
          {server.global && serverValue === "deny" && <Badge variant="outline">{t("offForAgent")}</Badge>}
          {overrides > 0 && <Badge variant="secondary">{t("overrides", { count: overrides })}</Badge>}
        </>
      }
      control={
        <PermissionControl
          value={serverValue}
          onChange={(p) => setPermissions((prev) => withServer(prev, server.slug, p))}
          label={t("controlFor", { name: server.name })}
        />
      }
    >
      {/* A global server cannot be removed from one agent, only denied. */}
      {server.global && <p className="py-1.5 pr-2 pl-3 text-xs text-muted-foreground sm:pl-9">{t("globalNote")}</p>}
      {server.tools === null ? (
        <div className="flex items-center justify-between gap-3 py-1.5 pr-2 pl-3 sm:pl-9">
          <p className="min-w-0 text-xs text-muted-foreground">{t("toolsNotLoaded")}</p>
          <Button type="button" variant="outline" onClick={load} disabled={loading}>
            {loadIcon}
            {t("loadTools")}
          </Button>
        </div>
      ) : rows.length ? (
        rows.map(({ tool, value }) => (
          <ToolRow
            key={tool.name}
            label={tool.name}
            mono
            description={tool.description}
            badges={
              <>
                <ToolHintBadge annotations={tool.annotations} builtin={server.builtin} />
                {permissions[mcpToolKey(server.slug, tool.name)] !== undefined && (
                  <Badge variant="secondary">{t("ownSetting")}</Badge>
                )}
              </>
            }
          >
            <PermissionControl
              value={value}
              onChange={(p) => setPermissions((prev) => withMcpTool(prev, server, tool, p))}
              label={t("controlFor", { name: tool.name })}
            />
          </ToolRow>
        ))
      ) : (
        <p className="py-2 pr-2 pl-3 text-xs text-muted-foreground sm:pl-9">{t("noTools")}</p>
      )}
      {/* Server actions live in the footer, so every row's control lines up on the right. */}
      <div className="flex items-center justify-between gap-2 py-0.5 pr-2 pl-3 text-xs text-muted-foreground sm:pl-9">
        <span className="min-w-0 truncate">
          <span className="font-mono">{server.slug}</span>
          {server.toolsSyncedAt ? (
            <>
              {" · "}
              {t("syncedAt")} <RelativeTime date={server.toolsSyncedAt} />
            </>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center">
          {server.tools !== null && (
            <Button
              type="button"
              variant="ghost"
              onClick={load}
              disabled={loading}
              aria-label={t("refreshAria", { name: server.name })}
              className="text-xs"
            >
              {loadIcon}
              {t("refresh")}
            </Button>
          )}
          {!server.global && (
            <Button
              type="button"
              variant="ghost"
              onClick={onRemove}
              aria-label={t("removeServer", { name: server.name })}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              <XIcon data-icon="inline-start" />
              {t("remove")}
            </Button>
          )}
        </span>
      </div>
    </PermissionGroup>
  );
}

/**
 * One collapsible section (a built-in group or an MCP server): a single header line with the
 * effective states and the group control; the tool rows show when opened.
 */
function PermissionGroup({
  icon: Icon,
  title,
  values,
  badges,
  control,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  /** Effective permission of each tool in the group, for the header summary. */
  values: ToolPermission[];
  badges?: React.ReactNode;
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
            {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="max-w-full truncate text-sm font-medium" title={title}>
                {title}
              </span>
              {badges}
              <StateSummary values={values} />
            </span>
          </button>
        </CollapsibleTrigger>
        {control}
      </div>
      <CollapsibleContent className="divide-y border-t bg-muted/20">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Icon and count per state present, e.g. "✓4 ✋1"; spelled out for screen readers. */
export function StateSummary({ values }: { values: ToolPermission[] }) {
  const t = useTranslations("agents.permissions");
  const present = TOOL_PERMISSIONS.map((p) => [p, values.filter((v) => v === p).length] as const).filter(([, n]) => n > 0);
  if (!present.length) return null;
  return (
    <span
      className="tabular inline-flex items-center gap-2 text-xs text-muted-foreground"
      title={present.map(([p, n]) => t(`summary.${p}`, { count: n })).join(", ")}
    >
      {present.map(([p, n]) => {
        const Icon = PERMISSION_ICONS[p];
        return (
          <span key={p} className="inline-flex items-center gap-0.5">
            <Icon className={cn("size-3.5", PERMISSION_TEXT[p])} aria-hidden />
            <span aria-hidden>{n}</span>
            <span className="sr-only">{t(`summary.${p}`, { count: n })}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * What an MCP tool declares about itself; the title names the permission it starts at, which a bundled
 * server can set instead of its hints.
 */
function ToolHintBadge({ annotations, builtin }: { annotations?: Record<string, unknown>; builtin: string | null }) {
  const t = useTranslations("agents.permissions");
  const permission = t(`options.${mcpToolDefault(annotations, builtin)}`);
  const hintDefault = builtinMcp(builtin)?.defaultPermission
    ? t("bundledDefault", { permission })
    : t("hintDefault", { permission });
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground" title={hintDefault}>
      {t(HINT_KEYS[mcpToolHint(annotations)])}
      <span className="sr-only">, {hintDefault}</span>
    </Badge>
  );
}

/** One dense line: name and description (clamped) on the left, the compact control on the right. */
function ToolRow({
  label,
  name,
  description,
  note,
  badges,
  mono,
  children,
}: {
  label: string;
  name?: string;
  description?: string;
  /** Why an option is unavailable; replaces the description line so it stays visible on touch. */
  note?: string;
  badges?: React.ReactNode;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 pr-2 pl-3 sm:pl-9">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate text-sm font-medium",
              // The label wins over the tool name, which takes what is left.
              name ? "max-w-full shrink-0" : "min-w-0",
              mono && "font-mono text-xs",
            )}
            title={name ? `${label} (${name})` : label}
          >
            {label}
          </span>
          {name && (
            // Hidden on phones: truncated next to the label it adds nothing; the label's title has it.
            <span
              className="hidden min-w-0 shrink-[3] truncate font-mono text-xs text-muted-foreground sm:inline"
              title={name}
            >
              {name}
            </span>
          )}
          {note && <LockIcon className={cn("size-3.5 shrink-0", PERMISSION_TEXT.ask)} aria-hidden />}
          {badges}
        </div>
        {note ? (
          <p className={cn("line-clamp-2 text-xs", PERMISSION_TEXT.ask)} title={description}>
            {note}
          </p>
        ) : (
          description && (
            <p className="truncate text-xs text-muted-foreground" title={description}>
              {description}
            </p>
          )
        )}
      </div>
      {children}
    </div>
  );
}

"use client";

import { builtinMcp, type BuiltinMcpKey } from "@abotica/core/mcp-builtins";
import {
  BotIcon,
  ExternalLinkIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LogInIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  RefreshCwIcon,
  UsersRoundIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { listCardClass, SectionEmptyLink, SectionIcon } from "@/components/app/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  connectMcpOAuth,
  type McpTestResult,
  setMcpServerEnabled,
  setMcpServerGlobal,
  testMcpById,
} from "@/server/actions/mcp";
import type { McpListItem } from "@/server/queries/mcp";
import { McpApiKeyDialog } from "./mcp-api-key-dialog";
import { OAuthStatusBadge } from "./mcp-oauth-panel";
import { McpServerIcon } from "./mcp-server-icon";
import { McpTestResultView } from "./mcp-test-result";
import { useMcpOAuthReturn } from "./use-mcp-oauth-return";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

type Patch = { id: string; enabled?: boolean; global?: boolean };

/** The bundled servers first, then the ones the user added. */
export function McpList({ builtin, user }: { builtin: McpListItem[]; user: McpListItem[] }) {
  const t = useTranslations("mcp.list");
  const [, startTransition] = useTransition();
  const [results, setResults] = useState<Record<string, McpTestResult>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [optimistic, setOptimistic] = useOptimistic([...builtin, ...user], (state, patch: Patch) =>
    state.map((s) => (s.id === patch.id ? { ...s, ...patch } : s)),
  );
  useMcpOAuthReturn({ list: true });

  function toggle(patch: Patch) {
    startTransition(async () => {
      setOptimistic(patch);
      const res =
        patch.global !== undefined
          ? await setMcpServerGlobal({ id: patch.id, global: patch.global })
          : await setMcpServerEnabled({ id: patch.id, enabled: patch.enabled ?? true });
      if (!res.ok) toast.error(res.error);
    });
  }

  async function test(id: string) {
    setTesting((t) => ({ ...t, [id]: true }));
    const res = await testMcpById({ id });
    setTesting((t) => ({ ...t, [id]: false }));
    if (!res.ok) return void toast.error(res.error);
    setResults((r) => ({ ...r, [id]: res.data }));
  }

  const card = { toggle, test, results, testing };
  const bundled = optimistic.filter((s) => s.builtin);
  const own = optimistic.filter((s) => !s.builtin);

  return (
    <>
      {bundled.length > 0 && (
        <section aria-labelledby="mcp-builtin" className="flex flex-col gap-4">
          <SectionHeading
            id="mcp-builtin"
            icon={PackageIcon}
            title={t("builtinTitle")}
            description={t("builtinDescription")}
          />
          <div className={GRID}>
            {bundled.map((s) => (
              <BuiltinCard key={s.id} server={s} {...card} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="mcp-user" className={cn("flex flex-col gap-4", bundled.length > 0 && "pt-2")}>
        <SectionHeading id="mcp-user" icon={PlugIcon} title={t("userTitle")} description={t("userDescription")} />
        {own.length ? (
          <div className={GRID}>
            {own.map((s) => (
              <UserCard key={s.id} server={s} {...card} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
            {t.rich("userEmpty", { link: (chunks) => <SectionEmptyLink href="/mcp/new">{chunks}</SectionEmptyLink> })}
          </p>
        )}
      </section>
    </>
  );
}

type CardProps = {
  server: McpListItem;
  toggle: (patch: Patch) => void;
  test: (id: string) => Promise<void>;
  results: Record<string, McpTestResult>;
  testing: Record<string, boolean>;
};

/** Icon centered on the title and subtitle, as on the agents page. */
function SectionHeading({
  id,
  icon,
  title,
  description,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <SectionIcon icon={icon} />
      <div className="min-w-0 space-y-0.5">
        <h2 id={id} className="text-base leading-snug font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

/**
 * What both cards share: the name link covering the card with the enabled switch, the badges (transport,
 * `badge`, tool count, `link`), the last test result, and a footer ending in `actions` and Test.
 */
function ServerCard({
  server: s,
  toggle,
  test,
  results,
  testing,
  subtitle,
  badge,
  link,
  footer,
  actions,
}: CardProps & {
  subtitle: React.ReactNode;
  badge: React.ReactNode;
  link?: React.ReactNode;
  footer: React.ReactNode;
  actions: React.ReactNode;
}) {
  const t = useTranslations("mcp.list");
  const tc = useTranslations("common.actions");
  const result = results[s.id];
  return (
    <div className={cn(listCardClass, !s.enabled && "opacity-70")}>
      <div className="flex items-center gap-3">
        <McpServerIcon transport={s.transport} builtin={s.builtin} size="xl" />
        <div className="min-w-0 flex-1">
          <Link
            href={`/mcp/${s.id}`}
            title={s.name}
            className="line-clamp-2 font-medium wrap-anywhere outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
          >
            {s.name}
          </Link>
          {subtitle}
        </div>
        <div className="relative z-10">
          <Switch
            checked={s.enabled}
            onCheckedChange={(enabled) => toggle({ id: s.id, enabled })}
            aria-label={s.enabled ? t("disable", { name: s.name }) : t("enable", { name: s.name })}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-normal">
          {s.transport === "http" ? "HTTP" : "stdio"}
        </Badge>
        {badge}
        {s.toolCount !== null && (
          <Badge variant="secondary" className="tabular font-normal">
            {t("tools", { count: s.toolCount })}
          </Badge>
        )}
        {link}
      </div>

      {result && (
        <div className="relative z-10">
          <McpTestResultView result={result} slug={s.slug} compact />
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {footer}
        <div className="relative z-10 ml-auto flex gap-1">
          {actions}
          <Button variant="ghost" size="sm" onClick={() => void test(s.id)} disabled={testing[s.id]}>
            {testing[s.id] ? <Spinner /> : <ZapIcon />} {tc("test")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function BuiltinCard(props: CardProps) {
  const { server: s, toggle } = props;
  const t = useTranslations("mcp.list");
  const tb = useTranslations("mcp.builtin");
  const tk = useTranslations("mcp.apiKey");
  const bundled = builtinMcp(s.builtin);
  const description = bundled ? tb(bundled.key as BuiltinMcpKey) : null;
  return (
    <ServerCard
      {...props}
      subtitle={
        description && (
          <p className="line-clamp-2 text-sm text-muted-foreground" title={description}>
            {description}
          </p>
        )
      }
      badge={
        s.apiKey !== null && (
          <Badge variant={s.apiKey ? "secondary" : "outline"} className="font-normal">
            {s.apiKey && <KeyRoundIcon aria-hidden />}
            {s.apiKey ? tk("set") : tk("anonymous")}
          </Badge>
        )
      }
      link={
        bundled && (
          <a
            href={bundled.docsUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={t("docsAria", { name: s.name })}
            className="relative z-10 ml-auto inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {t("docs")}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        )
      }
      footer={
        <label className="relative z-10 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={s.global}
            onCheckedChange={(global) => toggle({ id: s.id, global })}
            aria-label={t("allAgentsAria", { name: s.name })}
          />
          <span aria-hidden>{t("allAgents")}</span>
        </label>
      }
      actions={
        bundled?.transport === "http" && (
          <McpApiKeyDialog serverId={s.id} name={s.name} secret={bundled.apiKeySecret} keySet={Boolean(s.apiKey)}>
            <Button variant="ghost" size="sm" aria-label={tk("manageAria", { name: s.name })}>
              <KeyRoundIcon /> {tk("title")}
            </Button>
          </McpApiKeyDialog>
        )
      }
    />
  );
}

function UserCard(props: CardProps) {
  const { server: s } = props;
  const t = useTranslations("mcp.list");
  const to = useTranslations("mcp.oauth");
  const [connecting, setConnecting] = useState(false);
  const needsConnect = s.transport === "http" && (s.oauth === "disconnected" || s.oauth === "error");
  const target = s.transport === "http" ? (s.url ?? "") : [s.command, ...s.args].filter(Boolean).join(" ");

  /** The authorization page returns to the server page, which then loads the tools. */
  async function connect() {
    setConnecting(true);
    const res = await connectMcpOAuth({ id: s.id });
    if (res.ok) return window.location.assign(res.data.url);
    setConnecting(false);
    toast.error(res.error);
  }

  return (
    <ServerCard
      {...props}
      subtitle={
        <p className="truncate font-mono text-xs text-muted-foreground" title={target || undefined}>
          {target || t("notConfigured")}
        </p>
      }
      badge={
        s.transport === "http" &&
        s.oauth && (
          <OAuthStatusBadge
            state={s.oauth}
            subtle
            label={
              s.oauth === "connected" ? t("oauthConnected") : s.oauth === "error" ? t("oauthError") : t("oauthDisconnected")
            }
            title={s.oauth === "connected" ? t("oauthConnectedTitle") : undefined}
          />
        )
      }
      footer={
        <div className="flex gap-3 text-xs text-muted-foreground">
          {s.global ? (
            <span className="inline-flex items-center gap-1">
              <UsersRoundIcon className="size-3.5" aria-hidden /> {t("everyAgent")}
            </span>
          ) : (
            <>
              <span className="tabular inline-flex items-center gap-1">
                <BotIcon className="size-3.5" aria-hidden /> {t("agents", { count: s.agentCount })}
              </span>
              <span className="tabular inline-flex items-center gap-1">
                <FolderKanbanIcon className="size-3.5" aria-hidden /> {t("projects", { count: s.projectCount })}
              </span>
            </>
          )}
        </div>
      }
      actions={
        needsConnect && (
          <Button variant="outline" size="sm" onClick={() => void connect()} disabled={connecting}>
            {connecting ? <Spinner /> : s.oauth === "error" ? <RefreshCwIcon /> : <LogInIcon />}
            {s.oauth === "error" ? to("reconnect") : to("connect")}
          </Button>
        )
      }
    />
  );
}

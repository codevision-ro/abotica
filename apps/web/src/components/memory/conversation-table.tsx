import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { Lock, MessageSquare, Send } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";

const CHANNELS = ["web", "telegram", "internal"] as const;

const CHANNEL_ICON = { web: MessageSquare, telegram: Send, internal: Lock } as const;

/** Channel as a small badge with its icon, in the current language; unknown channels are shown as-is. */
export function ChannelBadge({
  channel,
  iconOnly,
  className,
}: {
  channel: string;
  /** Only the icon, the label stays for screen readers and as a tooltip; for narrow rows. */
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations("memory.conversations.channels");
  const known = (CHANNELS as readonly string[]).includes(channel);
  const Icon = known ? CHANNEL_ICON[channel as (typeof CHANNELS)[number]] : null;
  const label = known ? t(channel as (typeof CHANNELS)[number]) : channel;
  return (
    <Badge
      variant="outline"
      title={iconOnly ? label : undefined}
      className={cn(
        "h-5 border-border/80 font-normal text-muted-foreground",
        channel === "internal" && "border-transparent bg-muted",
        iconOnly && Icon && "size-6 px-0",
        className,
      )}
    >
      {Icon && <Icon aria-hidden />}
      <span className={cn(iconOnly && Icon && "sr-only")}>{label}</span>
    </Badge>
  );
}

type Row = {
  id: string;
  title: string;
  channel: string;
  updatedAt: Date;
  agentName: string;
  agentAvatar: AgentAvatarValue | null;
  messageCount: number;
};

/** `page` is the list page, carried so the transcript's back link returns to it. */
const conversationHref = (c: { id: string; channel: string }, page = 1) =>
  c.channel === "internal" ? `/memory/conversations/${c.id}${page > 1 ? `?page=${page}` : ""}` : `/chat/${c.id}`;

/** Table on wide screens, rows with the agent avatar below `md`; each row opens the conversation. */
export async function ConversationTable({ rows, page = 1 }: { rows: Row[]; page?: number }) {
  const [t, f] = await Promise.all([getTranslations("memory.conversations"), getFormat()]);
  const head = "h-10 px-3 text-left text-xs font-medium text-muted-foreground first:pl-5 last:pr-5";
  return (
    <>
      <table className="w-full table-fixed text-sm max-md:hidden">
        <thead className="bg-muted/30">
          <tr className="border-b border-border/60">
            <th className={head}>{t("columns.conversation")}</th>
            <th className={cn(head, "w-44")}>{t("columns.agent")}</th>
            <th className={cn(head, "w-28")}>{t("columns.channel")}</th>
            <th className={cn(head, "w-24 text-right max-lg:hidden")}>{t("columns.messages")}</th>
            <th className={cn(head, "w-32 text-right")}>{t("columns.updated")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((c) => (
            <tr key={c.id} className="group/row relative transition-colors hover:bg-muted/40">
              <td className="py-3 pr-3 pl-5">
                <Link
                  href={conversationHref(c, page)}
                  title={c.title}
                  className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
                >
                  {c.title}
                </Link>
              </td>
              <td className="px-3 py-3">
                <span className="flex min-w-0 items-center gap-2" title={c.agentName}>
                  <AgentAvatar avatar={c.agentAvatar} size="sm" />
                  <span className="truncate">{c.agentName}</span>
                </span>
              </td>
              <td className="px-3 py-3">
                <ChannelBadge channel={c.channel} />
              </td>
              <td className="tabular px-3 py-3 text-right text-muted-foreground max-lg:hidden">{c.messageCount}</td>
              <td className="py-3 pr-5 pl-3 text-right text-muted-foreground" title={f.dateTime(c.updatedAt)}>
                {f.relative(c.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-border/60 md:hidden">
        {rows.map((c) => (
          <li key={c.id}>
            <Link
              href={conversationHref(c, page)}
              className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
            >
              <AgentAvatar avatar={c.agentAvatar} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.title}</div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">{c.agentName}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{t("messageCount", { count: c.messageCount })}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{f.relative(c.updatedAt)}</span>
                </div>
              </div>
              <ChannelBadge channel={c.channel} iconOnly />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import { Brain, ChevronDown, FileText, Settings2, UserRound, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { MessageResponse } from "@/components/ai-elements/message";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { sectionCardClass } from "@/components/app/section-card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";

type Part = { type: string; [key: string]: unknown };
type TranscriptMessage = { id: string; role: string; parts: unknown[]; createdAt: Date };

/** Labels come from memory.transcript.roles.<role>; the assistant is shown by the agent's name. */
const ROLES = ["user", "system"] as const;

const json = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

function Fold({
  icon,
  title,
  meta,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible className="group/fold rounded-lg border border-border/70 bg-muted/30">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{title}</span>
        {meta && (
          <span className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
            {meta}
          </span>
        )}
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/fold:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/70 px-3 py-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>
      <pre className="max-h-96 overflow-auto rounded-md bg-background p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {typeof value === "string" ? value : json(value)}
      </pre>
    </div>
  );
}

function PartView({ part }: { part: Part }) {
  const t = useTranslations("memory.transcript");
  if (part.type === "step-start") return null;
  if (part.type === "text") return <MessageResponse>{String(part.text ?? "")}</MessageResponse>;
  if (part.type === "reasoning") {
    return (
      <Fold icon={<Brain className="size-3.5" />} title={t("reasoning")}>
        <p className="text-xs whitespace-pre-wrap text-muted-foreground wrap-anywhere">{String(part.text ?? "")}</p>
      </Fold>
    );
  }
  if (part.type === "file") {
    return (
      <a
        href={String(part.url ?? "#")}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
      >
        <FileText className="size-4 text-muted-foreground" />
        {String(part.filename ?? part.mediaType ?? t("file"))}
      </a>
    );
  }
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    const name = part.type === "dynamic-tool" ? String(part.toolName ?? "tool") : part.type.slice(5);
    return (
      <Fold
        icon={<Wrench className="size-3.5" />}
        title={name}
        meta={typeof part.state === "string" ? part.state : undefined}
      >
        <div className="space-y-2">
          {part.input !== undefined && <Json label={t("input")} value={part.input} />}
          {part.output !== undefined && <Json label={t("output")} value={part.output} />}
          {part.errorText !== undefined && <Json label={t("error")} value={part.errorText} />}
        </div>
      </Fold>
    );
  }
  return (
    <Fold icon={<FileText className="size-3.5" />} title={part.type}>
      <Json label={t("data")} value={part} />
    </Fold>
  );
}

function RoleIcon({ icon: Icon }: { icon: typeof UserRound }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/** Every message of a conversation in one card: who wrote it and when on top, the parts below. */
export async function MessageTranscript({
  messages,
  agent,
}: {
  messages: TranscriptMessage[];
  /** Shown on the assistant's messages. */
  agent: { name: string; avatar: AgentAvatarValue | null };
}) {
  const [t, f] = await Promise.all([getTranslations("memory.transcript.roles"), getFormat()]);
  const roleLabel = (role: string) =>
    (ROLES as readonly string[]).includes(role) ? t(role as (typeof ROLES)[number]) : role;
  return (
    <ol className={cn(sectionCardClass, "flex min-w-0 flex-col divide-y divide-border/60 overflow-hidden")}>
      {messages.map((m) => (
        <li
          key={m.id}
          className={cn("flex min-w-0 flex-col gap-2.5 px-4 py-4 sm:px-5", m.role === "user" && "bg-muted/30")}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            {m.role === "assistant" ? (
              <AgentAvatar avatar={agent.avatar} size="md" />
            ) : (
              <RoleIcon icon={m.role === "user" ? UserRound : Settings2} />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {m.role === "assistant" ? agent.name : roleLabel(m.role)}
            </span>
            <time
              dateTime={new Date(m.createdAt).toISOString()}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            >
              {f.dateTime(m.createdAt)}
            </time>
          </div>
          <div className="flex min-w-0 flex-col gap-2 text-sm wrap-anywhere sm:pl-9.5">
            {(m.parts as Part[]).map((part, i) => (
              <PartView key={i} part={part} />
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

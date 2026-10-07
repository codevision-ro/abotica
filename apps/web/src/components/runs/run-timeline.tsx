import {
  AlertTriangle,
  Box,
  Brain,
  ChevronRight,
  CircleAlert,
  FoldVertical,
  IterationCcw,
  Plug,
  Repeat2,
  RotateCw,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { ChatMarkdown } from "@/components/chat/chat-parts";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Format } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getFormat } from "@/server/format";
import { useToolLabel } from "../approvals/tool-label";
import { JsonBlock } from "./json-block";

type ModelRef = { provider?: string; model?: string } | null | undefined;
type ToolCall = { id?: string; name?: string; input?: unknown };
type ToolResult = { id?: string; name?: string; output?: unknown };
type StepData = {
  step?: number;
  provider?: string;
  model?: string;
  finishReason?: string;
  text?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  costUsd?: number;
};

type TimelineEvent = { id: number; type: string; data: Record<string, unknown>; createdAt: Date };
type Tone = "default" | "warning" | "destructive";

const modelName = (m: ModelRef) => (m ? [m.provider, m.model].filter(Boolean).join("/") : "");

/** Seconds with one decimal, for the waits of retry and fallback events. */
const seconds = (ms: unknown) => Math.round(Number(ms ?? 0) / 100) / 10;

/** Round marker on the rail, centered on the first line of its event. */
function Marker({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "absolute top-3 -left-[36.5px] flex size-6 items-center justify-center rounded-full border bg-background text-[11px] font-semibold tabular-nums ring-4 ring-card sm:-left-[40.5px] [&_svg]:size-3",
        tone === "warning" && "border-warning/40 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
        tone === "destructive" && "border-destructive/40 text-destructive",
        tone === "default" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

const ROW_TRIGGER =
  "group flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/60";

function Chevron() {
  return (
    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
  );
}

function RowIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
      {children}
    </span>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function ToolCallRow({ call, result }: { call: ToolCall; result: ToolResult | undefined }) {
  const t = useTranslations("runs.timeline");
  const tool = useToolLabel()(call.name ?? "");
  return (
    <Collapsible asChild>
      <li>
        <CollapsibleTrigger className={ROW_TRIGGER}>
          <Chevron />
          <RowIcon>{tool.server ? <Plug /> : <Wrench />}</RowIcon>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate font-medium">{tool.label}</span>
            <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{call.name}</span>
          </span>
          {!result && (
            <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
              {t("toolNoResult")}
            </Badge>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 px-3 pt-1 pb-3 sm:pl-[3.75rem]">
            <Labelled label={t("toolInput")}>
              <JsonBlock value={call.input ?? {}} />
            </Labelled>
            {result && (
              <Labelled label={t("toolResult")}>
                <JsonBlock value={result.output} />
              </Labelled>
            )}
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

function StepEvent({ data, fmt }: { data: StepData; fmt: Format }) {
  const t = useTranslations("runs.timeline");
  const finishKey = `finishReason.${data.finishReason}` as Parameters<typeof t>[0];
  const calls = data.toolCalls ?? [];
  const results = data.toolResults ?? [];
  const usage = data.usage ?? {};
  return (
    <Collapsible defaultOpen className="min-w-0 rounded-xl border border-border/70 bg-background/60 dark:bg-background/30">
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl px-3.5 py-3 text-left text-sm outline-none transition-colors hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:rounded-b-none sm:px-4">
        <Chevron />
        <span className="font-medium">{t("step", { step: data.step ?? "?" })}</span>
        {data.model && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{modelName(data)}</span>}
        {data.finishReason && (
          <Badge variant="secondary" className="font-normal">
            {t.has(finishKey) ? t(finishKey) : data.finishReason}
          </Badge>
        )}
        <span className="tabular w-full pl-6 text-xs text-muted-foreground sm:ml-auto sm:w-auto sm:pl-0">
          {usage.cachedInputTokens
            ? t("usageCached", {
                input: fmt.tokens(usage.inputTokens),
                cached: fmt.tokens(usage.cachedInputTokens),
                output: fmt.tokens(usage.outputTokens),
                cost: fmt.usd(data.costUsd),
              })
            : t("usage", {
                input: fmt.tokens(usage.inputTokens),
                output: fmt.tokens(usage.outputTokens),
                cost: fmt.usd(data.costUsd),
              })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-border/60 p-3.5 sm:p-4">
          {(data.reasoning || calls.length > 0) && (
            <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-card">
              {data.reasoning && (
                <Collapsible asChild>
                  <li>
                    <CollapsibleTrigger className={ROW_TRIGGER}>
                      <Chevron />
                      <RowIcon>
                        <Brain />
                      </RowIcon>
                      <span className="font-medium">{t("reasoning")}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <p className="px-3 pt-1 pb-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground sm:pl-[3.75rem]">
                        {data.reasoning}
                      </p>
                    </CollapsibleContent>
                  </li>
                </Collapsible>
              )}
              {calls.map((call, i) => (
                <ToolCallRow
                  key={call.id ?? i}
                  call={call}
                  result={results.find((r) => r.id && r.id === call.id) ?? (call.id ? undefined : results[i])}
                />
              ))}
            </ul>
          )}
          {data.text && <ChatMarkdown className="text-sm leading-6">{data.text}</ChatMarkdown>}
          {!data.text && !data.reasoning && calls.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("emptyStep")}</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function NoticeRow({
  tone,
  icon,
  title,
  children,
}: {
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-1 rounded-xl border px-3.5 py-3 text-sm sm:px-4 [&_svg]:size-4 [&_svg]:shrink-0",
        tone === "default" && "border-border/70 bg-background/60 dark:bg-background/30",
        tone === "warning" && "border-warning/30 bg-warning/8",
        tone === "destructive" && "border-destructive/25 bg-destructive/6",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 font-medium",
          tone === "default" && "text-foreground [&_svg]:text-muted-foreground",
          tone === "warning" && "text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
          tone === "destructive" && "text-destructive",
        )}
      >
        {icon}
        {title}
      </div>
      <div className="break-words text-muted-foreground">{children}</div>
    </div>
  );
}

function EventBody({ event, fmt }: { event: TimelineEvent; fmt: Format }) {
  const t = useTranslations("runs.timeline");
  const typeKey = `eventType.${event.type}` as Parameters<typeof t>[0];
  const title = t.has(typeKey) ? t(typeKey) : event.type;
  const code = (chunks: React.ReactNode) => <span className="font-mono text-foreground">{chunks}</span>;
  const d = event.data;
  const kindKey = `errorKind.${String(d.kind)}` as Parameters<typeof t>[0];
  const kind = t.has(kindKey) ? t(kindKey) : null;
  switch (event.type) {
    case "step":
      return <StepEvent data={d as StepData} fmt={fmt} />;
    case "fallback": {
      const from = modelName(d.from as ModelRef);
      const to = modelName(d.to as ModelRef);
      const error = String(d.error ?? "");
      const retries = Number(d.retries ?? 0);
      return (
        <NoticeRow tone="warning" icon={<Repeat2 />} title={title}>
          {to ? t.rich("fallbackSwitched", { from, to, code }) : t.rich("fallbackExhausted", { from, code })}
          {error && `: ${error}`}
          {kind && (
            <span className="mt-1 block text-xs">
              {retries > 0 ? t("fallbackRetried", { kind, retries, seconds: seconds(d.waitedMs) }) : kind}
            </span>
          )}
        </NoticeRow>
      );
    }
    case "retry": {
      const error = String(d.error ?? "");
      return (
        <NoticeRow tone="warning" icon={<RotateCw />} title={title}>
          {t.rich("retry", {
            kind: kind ?? String(d.kind ?? ""),
            model: modelName(d.model as ModelRef),
            seconds: seconds(d.delayMs),
            attempt: Number(d.attempt ?? 0),
            max: Number(d.maxRetries ?? 0),
            code,
          })}
          {error && `: ${error}`}
        </NoticeRow>
      );
    }
    case "loop-nudge": {
      const tools = Array.isArray(d.tools) ? d.tools.map(String).join(", ") : "";
      return (
        <NoticeRow tone="warning" icon={<IterationCcw />} title={title}>
          {t("loopNudge", { tools, steps: Number(d.steps ?? 0) })}
          <span className="mt-1 block text-xs">{String(d.text ?? "")}</span>
        </NoticeRow>
      );
    }
    case "compaction": {
      const reasonKey = `compactionReason.${String(d.reason)}` as Parameters<typeof t>[0];
      const flushed = Array.isArray(d.flushedMemoryIds) ? d.flushedMemoryIds.length : 0;
      const summary = String(d.summary ?? "");
      return (
        <NoticeRow tone="default" icon={<FoldVertical />} title={title}>
          {t.rich("compaction", {
            before: fmt.tokens(Number(d.before ?? 0)),
            after: fmt.tokens(Number(d.after ?? 0)),
            model: modelName(d.model as ModelRef),
            cost: fmt.usd(Number(d.costUsd ?? 0)),
            code,
          })}
          <span className="mt-1 block text-xs">
            {[
              t.has(reasonKey) ? t(reasonKey) : String(d.reason ?? ""),
              d.midRun ? t("compactionMidRun") : null,
              flushed ? t("compactionFlushed", { count: flushed }) : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </span>
          {summary && (
            <Collapsible className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-card">
              <CollapsibleTrigger className={ROW_TRIGGER}>
                <Chevron />
                <span className="font-medium text-foreground">{t("compactionSummary")}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ChatMarkdown className="px-3 pt-1 pb-3 text-sm leading-6 sm:pl-9">{summary}</ChatMarkdown>
              </CollapsibleContent>
            </Collapsible>
          )}
        </NoticeRow>
      );
    }
    case "compaction-error":
      return (
        <NoticeRow tone="destructive" icon={<FoldVertical />} title={title}>
          {String(d.error ?? d.message ?? JSON.stringify(d))}
        </NoticeRow>
      );
    case "mcp-error":
      return (
        <NoticeRow tone="destructive" icon={<Plug />} title={title}>
          {String(d.error ?? d.message ?? JSON.stringify(d))}
        </NoticeRow>
      );
    case "sandbox-error":
      return (
        <NoticeRow tone="destructive" icon={<Box />} title={title}>
          {String(d.error ?? d.message ?? JSON.stringify(d))}
        </NoticeRow>
      );
    case "error":
      return (
        <NoticeRow tone="destructive" icon={<CircleAlert />} title={title}>
          {String(d.message ?? d.error ?? JSON.stringify(d))}
        </NoticeRow>
      );
    default:
      return (
        <NoticeRow tone="warning" icon={<AlertTriangle />} title={title}>
          <JsonBlock value={d} className="mt-1.5" />
        </NoticeRow>
      );
  }
}

function EventIcon({ type }: { type: string }) {
  if (type === "fallback") return <Repeat2 />;
  if (type === "retry") return <RotateCw />;
  if (type === "loop-nudge") return <IterationCcw />;
  if (type === "compaction" || type === "compaction-error") return <FoldVertical />;
  return <CircleAlert />;
}

export async function RunTimeline({ events }: { events: TimelineEvent[] }) {
  const fmt = await getFormat();
  return (
    <ol className="relative ml-3 min-w-0 space-y-4 border-l border-border/70 pl-6 sm:pl-7">
      {events.map((event) => {
        const warning = event.type === "fallback" || event.type === "retry" || event.type === "loop-nudge";
        const neutral = event.type === "step" || event.type === "compaction";
        const tone: Tone = warning ? "warning" : neutral ? "default" : "destructive";
        const step = event.type === "step" ? (event.data as StepData).step : undefined;
        return (
          <li key={event.id} className="relative">
            <Marker tone={tone}>{step ?? <EventIcon type={event.type} />}</Marker>
            <EventBody event={event} fmt={fmt} />
          </li>
        );
      })}
    </ol>
  );
}

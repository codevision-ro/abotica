"use client";

import { CircleCheckIcon, CircleOffIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/app/relative-time";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { checkSandbox } from "@/server/actions/sandbox";
import type { SandboxStatusView } from "@/server/queries/sandbox";

/** How long the button spins when the worker never answers (not running, queue stuck). */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Asks the worker to check the sandbox again and spins until its answer refreshes the page (a new
 * `checkedAt`), or for CHECK_TIMEOUT_MS when no worker answers.
 */
export function SandboxCheckButton({ checkedAt }: { checkedAt: string | null }) {
  const t = useTranslations("sandbox.settings.status");
  const router = useRouter();
  const [requesting, startRequest] = useTransition();
  // `checkedAt` when the check was requested. The worker publishes an event after the check, which
  // refreshes the page with a new `checkedAt`, and that ends the wait.
  const [requestedAt, setRequestedAt] = useState<string | null | undefined>(undefined);
  const waiting = requestedAt !== undefined && requestedAt === checkedAt;

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setRequestedAt(undefined);
      router.refresh();
    }, CHECK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting, router]);

  function checkAgain() {
    startRequest(async () => {
      const res = await checkSandbox({});
      if (!res.ok) return void toast.error(t("checkFailed"), { description: res.error });
      setRequestedAt(checkedAt);
    });
  }

  const busy = requesting || waiting;
  return (
    <Button type="button" variant="outline" size="sm" onClick={checkAgain} disabled={busy}>
      {busy ? <Spinner /> : <RefreshCwIcon />}
      <span className="max-sm:sr-only">{t("checkAgain")}</span>
    </Button>
  );
}

/** Whether containers run, why not and how to fix it, and the tools found; a note when nothing checked yet. */
export function SandboxStatus({ status }: { status: SandboxStatusView }) {
  const t = useTranslations("sandbox.settings.status");
  if (!status) return <p className="text-sm text-muted-foreground">{t("none")}</p>;
  const off = !status.enabled;
  const ready = status.isolation !== null;
  const tools = status.tools.filter((tool) => tool.version !== null);
  const fix = status.docker.configured ? t("fix.dockerUnreachable") : t("fix.dockerNotConfigured");

  const headline = ready ? t("running") : off ? t("off") : t("unavailable");
  const detail = ready ? t(`isolation.${status.isolation!}`) : off ? t("offHint") : t("unavailableHint");
  const Icon = ready ? CircleCheckIcon : off ? CircleOffIcon : TriangleAlertIcon;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            ready
              ? "bg-success/12 text-[color-mix(in_oklch,var(--success),black_15%)] dark:text-success"
              : off
                ? "bg-muted text-muted-foreground"
                : "bg-warning/12 text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning",
          )}
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {headline}
            {ready && <span className="sr-only">: {t("ready")}</span>}
          </p>
          <p className="text-sm text-pretty text-muted-foreground">{detail}</p>
        </div>
      </div>

      {!ready && !off && (
        <div className="space-y-2 rounded-xl border border-warning/30 bg-warning/5 p-3 sm:p-4">
          <p className="text-sm font-medium">{t("fixTitle")}</p>
          <p className="text-sm text-pretty">{fix}</p>
        </div>
      )}

      {!ready && status.docker.reason && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("details")}</p>
          <p className="font-mono text-xs wrap-anywhere text-muted-foreground">{`Docker: ${status.docker.reason}`}</p>
        </div>
      )}

      {ready && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("tools")}</p>
          {tools.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="inline-flex h-6 items-center rounded-full border bg-background px-2.5 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/20"
                      >
                        {tool.name}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72 font-mono">{tool.version}</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noTools")}</p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t.rich("checked", { time: () => <RelativeTime date={status.checkedAt} /> })}
      </p>
    </div>
  );
}

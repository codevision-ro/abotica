"use client";

import { CheckIcon, CopyIcon, ShieldCheck, SquareTerminal, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** The installer is also the updater: the same one-line command, per operating system. */
function commands(repo: string) {
  const raw = `https://raw.githubusercontent.com/${repo}/main`;
  return [
    { value: "unix", shell: "terminal", command: `curl -fsSL ${raw}/install.sh | bash` },
    { value: "windows", shell: "powershell", command: `irm ${raw}/install.ps1 | iex` },
  ] as const;
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  const t = useTranslations("settings.updates");
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-muted/30 dark:bg-input/10">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/40 py-1.5 pr-1.5 pl-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button variant="ghost" size="xs" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      <pre className="p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">
        <code>{command}</code>
      </pre>
    </div>
  );
}

/**
 * Settings > Updates, when a newer release exists: the command to run, and what happens to the data
 * and to the runs in progress (`runningRuns`), which the restart stops.
 */
export function UpdateCommand({ repo, runningRuns }: { repo: string; runningRuns: number }) {
  const t = useTranslations("settings.updates");
  const options = commands(repo);
  return (
    <SectionCard icon={SquareTerminal} title={t("howToTitle")} description={t("howToDescription")}>
      <div className="flex flex-col gap-4">
        <Tabs defaultValue="unix" className="gap-3">
          <TabsList aria-label={t("platformLabel")} className="w-full sm:w-fit">
            {options.map((o) => (
              <TabsTrigger key={o.value} value={o.value} className="px-3">
                {t(o.value)}
              </TabsTrigger>
            ))}
          </TabsList>
          {options.map((o) => (
            <TabsContent key={o.value} value={o.value}>
              <CommandBlock label={t(o.shell)} command={o.command} />
            </TabsContent>
          ))}
        </Tabs>
        {runningRuns > 0 && (
          <p className="flex gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-pretty">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklch,var(--warning),black_20%)] dark:text-warning"
              aria-hidden
            />
            <span>{t("activeRuns", { count: runningRuns })}</span>
          </p>
        )}
        <p className="flex gap-2 text-sm text-pretty text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span>
            {t.rich("safe", {
              link: (chunks) => (
                <a
                  href={`https://github.com/${repo}/blob/main/DEPLOY.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {chunks}
                </a>
              ),
            })}
          </span>
        </p>
      </div>
    </SectionCard>
  );
}

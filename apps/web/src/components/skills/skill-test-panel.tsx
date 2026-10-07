"use client";

import { compareSkillPaths, SKILL_MD } from "@abotica/core/skill-md";
import { ChevronRightIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { startSkillTest } from "@/server/actions/skills";
import type { PickerOption } from "./assignment-picker";

const mono = (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>;

/**
 * Tries the skill for real: the picked agent gets it in a new conversation, assigned or not. Below,
 * what the agent receives: its line in the system prompt and the `skill_read` result.
 */
export function SkillTestPanel({
  skillId,
  slug,
  name,
  description,
  skillMd,
  filePaths,
  agents,
  dirty,
}: {
  /** Missing while the skill is not saved yet. */
  skillId?: string;
  slug: string;
  name: string;
  description: string;
  /** SKILL.md body, without frontmatter. */
  skillMd: string;
  filePaths: string[];
  agents: PickerOption[];
  /** The form has unsaved changes: the test runs the saved version. */
  dirty: boolean;
}) {
  const t = useTranslations("skills.test");
  const router = useRouter();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const selectedAgent = agents.find((a) => a.id === agentId);
  const [pending, startTransition] = useTransition();
  const canStart = Boolean(skillId && agentId && prompt.trim()) && !pending;

  function start() {
    if (!skillId || !canStart) return;
    startTransition(async () => {
      const res = await startSkillTest({ skillId, agentId, prompt });
      if (!res.ok) return void toast.error(res.error);
      router.push(`/chat/${res.data.conversationId}`);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("runTitle")}</h3>
          <p className="text-sm text-pretty text-muted-foreground">{skillId ? t("hint") : t("saveFirst")}</p>
          {skillId && dirty && (
            <p className="text-sm text-pretty text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning">
              {t("dirtyHint")}
            </p>
          )}
        </div>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("noAgents")}{" "}
            <Link href="/agents/new" className="underline underline-offset-2 hover:text-foreground">
              {t("createAgent")}
            </Link>
          </p>
        ) : (
          // Not a <form>: the panel sits inside the skill form.
          <fieldset disabled={!skillId || pending} className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skill-test-agent">{t("agentLabel")}</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="skill-test-agent" className="w-full sm:w-72">
                  {/* The trigger shows the value as one block line; avatar and name need their own row. */}
                  <SelectValue>
                    {selectedAgent && (
                      <span className="flex min-w-0 items-center gap-2">
                        <AgentAvatar avatar={selectedAgent.avatar} size="xs" />
                        <span className="truncate">{selectedAgent.name}</span>
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[min(32rem,calc(100vw-2rem))]">
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id} title={a.name} className="*:[span]:last:min-w-0">
                      <AgentAvatar avatar={a.avatar} size="xs" />
                      <span className="truncate">{a.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="skill-test-prompt">{t("promptLabel")}</Label>
              <Textarea
                id="skill-test-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    start();
                  }
                }}
                placeholder={t("promptPlaceholder")}
                className="min-h-20"
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">{t("cost")}</p>
              {/* With unsaved changes, saving is the page's primary action. */}
              <Button type="button" variant={dirty ? "outline" : "default"} onClick={start} disabled={!canStart}>
                {pending ? <Spinner /> : <PlayIcon />} {t("start")}
              </Button>
            </div>
          </fieldset>
        )}
      </div>

      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />

      <SkillPreview slug={slug} name={name} description={description} skillMd={skillMd} filePaths={filePaths} />
    </div>
  );
}

/** What the agent receives: its line in the system prompt and what `skill_read` returns. */
function SkillPreview({
  slug,
  name,
  description,
  skillMd,
  filePaths,
}: {
  slug: string;
  name: string;
  description: string;
  skillMd: string;
  filePaths: string[];
}) {
  const t = useTranslations("skills.test");
  const shownSlug = slug || "slug";
  const promptLine = `- ${shownSlug}: ${name || t("namePlaceholder")}. ${description}`.trimEnd();
  const others = filePaths.filter((p) => p !== SKILL_MD).sort(compareSkillPaths);
  const toolResult = JSON.stringify({ slug: shownSlug, path: SKILL_MD, instructions: skillMd, files: others }, null, 2);

  return (
    <Collapsible className="group/preview">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/preview:rotate-90"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t("previewTitle")}</span>
          <span className="block text-xs text-muted-foreground">{t("previewSummary")}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("inPrompt")}</p>
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {`${t("promptIntro")}\n`}
              {promptLine}
            </pre>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t.rich("result", { call: `skill_read({ slug: "${shownSlug}" })`, mono })}
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {toolResult}
            </pre>
            {others.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t.rich("otherFiles", { call: `skill_read({ slug: "${shownSlug}", path })`, mono })}
              </p>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

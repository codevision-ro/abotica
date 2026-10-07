import { defaultPermissions } from "@abotica/core";
import { DEFAULT_AGENT_LIMITS } from "@abotica/db";
import { DEFAULT_AGENT_AVATAR } from "@abotica/db/avatar";
import { ArrowLeftIcon, FilePlus2Icon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AgentForm, type AgentFormInitial } from "@/components/agents/agent-form";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { PageBody } from "@/components/app/page-header";
import { chipVariants } from "@/components/app/selectable-chip";
import { Button } from "@/components/ui/button";
import { getAgentFormOptions, getTemplateBySlug, listTemplates } from "@/server/queries/agents";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents.meta");
  return { title: t("new") };
}

export default async function NewAgentPage(props: PageProps<"/agents/new">) {
  const t = await getTranslations("agents.new");
  const sp = await props.searchParams;
  const templateSlug = typeof sp.template === "string" ? sp.template : undefined;

  const [options, templates, template] = await Promise.all([
    getAgentFormOptions(),
    listTemplates(),
    templateSlug ? getTemplateBySlug(templateSlug) : null,
  ]);
  if (templateSlug && !template) notFound();

  const initial: AgentFormInitial = template
    ? {
        name: template.agent.name,
        role: template.agent.role,
        avatar: template.agent.avatar,
        systemPrompt: template.agent.systemPrompt,
        provider: template.agent.provider,
        model: template.agent.model,
        fallbacks: template.agent.fallbacks,
        reasoningEffort: template.agent.reasoningEffort,
        permissions: template.agent.permissions,
        limits: template.agent.limits,
        skillIds: template.skillIds,
        mcpServerIds: template.mcpServerIds,
        projectIds: [],
      }
    : {
        name: "",
        role: "",
        avatar: DEFAULT_AGENT_AVATAR,
        systemPrompt: "",
        provider: null,
        model: null,
        fallbacks: [],
        reasoningEffort: "default",
        permissions: defaultPermissions({ isOrchestrator: false, isManager: false }),
        limits: DEFAULT_AGENT_LIMITS,
        skillIds: [],
        mcpServerIds: [],
        projectIds: [],
      };

  return (
    <PageBody>
      <Button variant="ghost" size="sm" className="-mb-2 self-start" asChild>
        <Link href="/agents">
          <ArrowLeftIcon /> {t("back")}
        </Link>
      </Button>
      {/* The agent's name in the form is the visible title; this one names the page for screen readers. */}
      <h1 className="sr-only">{t("title")}</h1>
      <nav aria-label={t("startFrom")} className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm text-muted-foreground">{t("startFrom")}</span>
        <Link
          href="/agents/new"
          aria-current={template ? undefined : "page"}
          className={chipVariants({ selected: !template, className: "pl-2" })}
        >
          <FilePlus2Icon className="size-4" aria-hidden />
          {t("blank")}
        </Link>
        {templates.map((tpl) => {
          const selected = tpl.slug === template?.agent.slug;
          return (
            <Link
              key={tpl.id}
              href={`/agents/new?template=${tpl.slug}`}
              aria-current={selected ? "page" : undefined}
              title={tpl.role || undefined}
              className={chipVariants({ selected, className: "pl-1.5" })}
            >
              <AgentAvatar avatar={tpl.avatar} size="xs" className="rounded-full" />
              <span className="truncate">{tpl.name}</span>
            </Link>
          );
        })}
      </nav>
      {/* A new starting point resets the form state. */}
      <AgentForm
        key={template?.agent.slug ?? "blank"}
        mode={{ kind: "create", templateSlug: template?.agent.slug }}
        initial={initial}
        options={options}
      />
    </PageBody>
  );
}

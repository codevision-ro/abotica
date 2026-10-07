import { LayoutTemplateIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentCard, TemplateCard } from "@/components/agents/agent-card";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionEmptyLink, SectionIcon } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { getAgentList } from "@/server/queries/agents";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents.meta");
  return { title: t("title") };
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

export default async function AgentsPage() {
  const [{ agents, templates }, t] = await Promise.all([getAgentList(), getTranslations("agents.list")]);

  return (
    <PageBody>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild>
            <Link href="/agents/new">
              <PlusIcon /> {t("newAgent")}
            </Link>
          </Button>
        }
      />

      {agents.length ? (
        <div className={GRID}>
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          {t.rich("empty", { link: (chunks) => <SectionEmptyLink href="/agents/new">{chunks}</SectionEmptyLink> })}
        </p>
      )}

      <section aria-labelledby="agent-templates" className="flex flex-col gap-4 pt-2">
        <div className="flex items-center gap-3">
          <SectionIcon icon={LayoutTemplateIcon} />
          <div className="min-w-0 space-y-0.5">
            <h2 id="agent-templates" className="text-base leading-snug font-semibold tracking-tight">
              {t("templates.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("templates.description")}</p>
          </div>
        </div>
        {templates.length ? (
          <div className={GRID}>
            {templates.map((tpl) => (
              <TemplateCard key={tpl.id} agent={tpl} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("templates.empty")}</p>
        )}
      </section>
    </PageBody>
  );
}

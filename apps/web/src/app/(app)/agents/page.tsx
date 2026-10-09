import { MANAGER_TEMPLATE_SLUG } from "@abotica/core";
import { CrownIcon, type LucideIcon, PlusIcon, SparklesIcon, UsersIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AgentCard } from "@/components/agents/agent-card";
import { PageBody, PageHeader } from "@/components/app/page-header";
import { SectionEmptyLink, SectionIcon } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { getAgentList } from "@/server/queries/agents";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents.meta");
  return { title: t("title") };
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3";

/** The agents by kind: the super agent, the managers, then the specialists. */
export default async function AgentsPage() {
  const [agents, t] = await Promise.all([getAgentList(), getTranslations("agents.list")]);
  const orchestrator = agents.filter((a) => a.kind === "orchestrator");
  const managers = agents.filter((a) => a.kind === "manager");
  const specialists = agents.filter((a) => a.kind === "specialist");
  const emptyLink = (href: string) =>
    function EmptyLink(chunks: React.ReactNode) {
      return <SectionEmptyLink href={href}>{chunks}</SectionEmptyLink>;
    };

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

      {orchestrator.length > 0 && (
        <AgentGroup
          id="agents-orchestrator"
          icon={SparklesIcon}
          title={t("groups.orchestrator.title")}
          description={t("groups.orchestrator.description")}
        >
          <div className={GRID}>
            {orchestrator.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        </AgentGroup>
      )}

      <AgentGroup
        id="agents-managers"
        icon={CrownIcon}
        title={t("groups.managers.title")}
        description={t("groups.managers.description")}
      >
        {managers.length ? (
          <div className={GRID}>
            {managers.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t.rich("groups.managers.empty", { link: emptyLink(`/agents/new?template=${MANAGER_TEMPLATE_SLUG}`) })}
          </p>
        )}
      </AgentGroup>

      <AgentGroup
        id="agents-specialists"
        icon={UsersIcon}
        title={t("groups.specialists.title")}
        description={t("groups.specialists.description")}
      >
        {specialists.length ? (
          <div className={GRID}>
            {specialists.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t.rich("groups.specialists.empty", { link: emptyLink("/agents/new") })}
          </p>
        )}
      </AgentGroup>
    </PageBody>
  );
}

function AgentGroup({
  id,
  icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 pt-2 first-of-type:pt-0">
      <div className="flex items-center gap-3">
        <SectionIcon icon={icon} />
        <div className="min-w-0 space-y-0.5">
          <h2 id={id} className="text-base leading-snug font-semibold tracking-tight">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

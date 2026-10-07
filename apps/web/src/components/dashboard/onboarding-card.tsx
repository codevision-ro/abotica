import { ArrowRightIcon, CheckIcon, RocketIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SectionCard, SectionList } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type Step = { id: string; title: string; description: React.ReactNode; done: boolean; href?: string; cta?: string };

const code = (chunks: React.ReactNode) => <code className="rounded bg-muted px-1 font-mono text-[11px]">{chunks}</code>;

export async function OnboardingCard({
  state,
}: {
  state: { hasKeys: boolean; hasAgents: boolean; hasProjects: boolean; hasTelegram: boolean };
}) {
  const t = await getTranslations("dashboard.onboarding");
  const steps: Step[] = [
    {
      id: "keys",
      title: t("keys.title"),
      description: t("keys.description"),
      done: state.hasKeys,
      href: "/settings",
      cta: t("keys.cta"),
    },
    {
      id: "telegram",
      title: t("telegram.title"),
      description: t.rich("telegram.description", { code }),
      done: state.hasTelegram,
    },
    {
      id: "agent",
      title: t("agent.title"),
      description: t("agent.description"),
      done: state.hasAgents,
      href: "/agents/new",
      cta: t("agent.cta"),
    },
    {
      id: "project",
      title: t("project.title"),
      description: t("project.description"),
      done: state.hasProjects,
      href: "/projects/new",
      cta: t("project.cta"),
    },
  ];
  const done = steps.filter((s) => s.done).length;
  // The page's one primary action: the first open step that can be done from here.
  const nextId = steps.find((s) => !s.done && s.href)?.id;

  return (
    <SectionCard
      icon={RocketIcon}
      title={t("title")}
      description={t("progress", { done, total: steps.length })}
      flush
      action={
        <Progress
          value={(done / steps.length) * 100}
          aria-label={t("progress", { done, total: steps.length })}
          className="hidden h-1.5 w-28 sm:flex"
        />
      }
    >
      <SectionList>
        {steps.map((step, i) =>
          step.done ? null : (
            <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
              <span className="tabular flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-xs font-semibold text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-48 flex-1">
                <div className="text-sm font-medium">{step.title}</div>
                <p className="text-xs text-pretty text-muted-foreground">{step.description}</p>
              </div>
              {step.href && (
                <Button asChild variant={step.id === nextId ? "default" : "outline"} size="sm" className="ml-auto shrink-0">
                  <Link href={step.href}>
                    {step.cta}
                    <ArrowRightIcon />
                  </Link>
                </Button>
              )}
            </li>
          ),
        )}
        {done > 0 && (
          <li className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
            <span className="sr-only">{t("done")}:</span>
            {steps
              .filter((s) => s.done)
              .map((s) => (
                <span
                  key={s.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-success/10 py-1 pr-2.5 pl-1.5 text-xs text-muted-foreground"
                >
                  <CheckIcon className="size-3.5 text-success" aria-hidden />
                  {s.title}
                </span>
              ))}
          </li>
        )}
      </SectionList>
    </SectionCard>
  );
}

import {
  BookOpen,
  Bot,
  ChevronRight,
  FolderKanban,
  Globe,
  History,
  Layers,
  type LucideIcon,
  NotebookPen,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { SectionIcon, sectionCardClass } from "@/components/app/section-card";
import { cn } from "@/lib/utils";

/** Labels come from memory.priority.levels.<key>. */
const LEVELS: { key: "global" | "project" | "agent" | "agentProject" | "journal" | "raw"; icon: LucideIcon }[] = [
  { key: "global", icon: Globe },
  { key: "project", icon: FolderKanban },
  { key: "agent", icon: Bot },
  { key: "agentProject", icon: NotebookPen },
  { key: "journal", icon: BookOpen },
  { key: "raw", icon: History },
];

/**
 * On conflict, left to right: the team memory (the project's decisions agreed with the user), the user's
 * global rules, the agent's notes on the project, then its craft. Labels come from memory.priority.precedence.
 */
const PRECEDENCE = ["team", "global", "agentProject", "agentGlobal"] as const;

export function PriorityCard() {
  const t = useTranslations("memory.priority");
  return (
    <section aria-labelledby="memory-priority" className={cn(sectionCardClass, "min-w-0")}>
      <div className="flex items-center gap-3 px-4 py-3">
        <SectionIcon icon={Layers} />
        <h2 id="memory-priority" className="min-w-0 flex-1 text-sm font-semibold tracking-tight">
          {t("title")}
        </h2>
      </div>
      <div aria-hidden className="h-px bg-linear-to-r from-border via-border/50 to-transparent" />
      <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
        <ol aria-label={t("order")} className="flex flex-wrap items-center gap-1">
          {PRECEDENCE.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />}
              <li
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-medium",
                  i === 0 ? "bg-primary/10 text-primary dark:bg-primary/20" : "bg-muted text-foreground/80",
                )}
              >
                {t(`precedence.${s}`)}
              </li>
            </Fragment>
          ))}
        </ol>
        <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
      </div>
      <dl className="flex flex-col py-1.5">
        {LEVELS.map(({ key, icon: Icon }) => (
          <div key={key} className="flex items-center gap-3 px-4 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <dt className="flex items-baseline justify-between gap-3 text-sm">
                <span className="shrink-0 font-medium">{t(`levels.${key}.name`)}</span>
                <span className="text-right text-[11px] leading-tight text-muted-foreground">{t(`levels.${key}.who`)}</span>
              </dt>
              <dd className="text-xs text-muted-foreground">{t(`levels.${key}.what`)}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}

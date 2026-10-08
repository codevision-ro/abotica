"use client";

import type { SandboxPolicy } from "@abotica/core/sandbox-policy";
import {
  BoxesIcon,
  CheckIcon,
  CrownIcon,
  GaugeIcon,
  PlusIcon,
  SaveIcon,
  SendIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { FormPage } from "@/components/app/form-page";
import { FormSection, FormSectionCollapsible, FormSubsection, scrollToSection } from "@/components/app/form-section";
import { heroFieldVariants } from "@/components/app/hero-fields";
import { OptionCards } from "@/components/app/option-cards";
import { chipVariants, SelectableChip } from "@/components/app/selectable-chip";
import { SummaryItem, SummaryList, type SummaryStatus } from "@/components/app/summary-rail";
import { SandboxPolicyEditor, usePolicySummary } from "@/components/sandbox/sandbox-policy-editor";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { cn } from "@/lib/utils";
import { createProject, updateProject } from "@/server/actions/projects";
import type { JoinableAgent, LeadableAgent } from "@/server/queries/projects";

type ProjectFormValues = {
  name: string;
  description: string;
  goals: string;
  budgetUsd: number | null;
  allowedProviders: string[];
  telegramTopicId: number | null;
  /** Own sandbox policy; null follows the default from Settings > Sandbox. */
  sandbox?: SandboxPolicy | null;
};

/** The submit buttons sit in the rail and the bottom bar, outside the form, and point at it by id. */
const FORM_ID = "project-form";

/** Section ids: scroll targets of the summary rail. */
const SECTIONS = {
  identity: "project-identity",
  goals: "project-goals",
  team: "project-team",
  limits: "project-limits",
  sandbox: "project-sandbox",
  telegram: "project-telegram",
} as const;

type FormError = { field: "budget" | "topic" | null; message: string };

export function ProjectForm({
  projectId,
  initial,
  specialists = [],
  managers = [],
  providers,
  sandboxDefault,
  footer,
}: {
  projectId?: string;
  initial?: ProjectFormValues;
  /** New project only: agents it can start with besides the manager (the team is edited in its Team tab later). */
  specialists?: JoinableAgent[];
  /** New project only: managers that can lead it; none chosen creates one from the template. */
  managers?: LeadableAgent[];
  providers: { id: string; label: string }[];
  /** Default sandbox policy; the Sandbox section shows only when it is given (editing). */
  sandboxDefault?: SandboxPolicy;
  /** Rendered after the sections, outside the form, e.g. the danger zone. */
  footer?: React.ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations("projects.form");
  const tc = useTranslations("common");
  const ts = useTranslations("sandbox.project");
  const policySummary = usePolicySummary();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [goals, setGoals] = useState(initial?.goals ?? "");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [managerId, setManagerId] = useState<string | null>(null);
  const [budget, setBudget] = useState(initial?.budgetUsd != null ? String(initial.budgetUsd) : "");
  const [allowed, setAllowed] = useState<string[]>(initial?.allowedProviders ?? []);
  const [topic, setTopic] = useState(initial?.telegramTopicId != null ? String(initial.telegramTopicId) : "");
  const [error, setError] = useState<FormError | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [sandbox, setSandbox] = useState<SandboxPolicy | null>(initial?.sandbox ?? null);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  // Remembers the custom policy while "use the default" is picked, so switching back restores it.
  const customSandbox = useRef<SandboxPolicy | null>(initial?.sandbox ?? null);
  // Lists sorted, so toggling something back makes the form clean again.
  const { dirty, markSaved } = useDirtySnapshot([
    name,
    description,
    goals,
    [...memberIds].sort(),
    managerId,
    budget,
    [...allowed].sort(),
    topic,
    sandbox,
  ]);

  function toggle(list: string[], value: string, on: boolean) {
    return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  }

  /** Shows a field error with its section open and in view. */
  function fieldError(field: "budget" | "topic", message: string) {
    setError({ field, message });
    if (field === "budget") setLimitsOpen(true);
    else setTelegramOpen(true);
    requestAnimationFrame(() => scrollToSection(field === "budget" ? SECTIONS.limits : SECTIONS.telegram));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const budgetUsd = budget.trim() === "" ? null : Number(budget.replace(",", "."));
    const telegramTopicId = topic.trim() === "" ? null : Number(topic);
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      return fieldError("budget", t("invalidBudget"));
    }
    if (telegramTopicId !== null && !Number.isInteger(telegramTopicId)) return fieldError("topic", t("invalidTopic"));
    const input = { name, description, goals, budgetUsd, allowedProviders: allowed, telegramTopicId };
    startTransition(async () => {
      const res = projectId
        ? await updateProject({ id: projectId, ...input, ...(sandboxDefault && { sandbox }) })
        : await createProject({ ...input, memberIds, managerAgentId: managerId ?? undefined });
      if (!res.ok) {
        setError({ field: null, message: res.error });
        toast.error(res.error);
        return;
      }
      toast.success(projectId ? t("saved") : t("created"));
      markSaved();
      // Replace, not push: Back from the project must not land on the form just submitted.
      router.replace(`/projects/${res.data.id}`);
      router.refresh();
    });
  }

  const editing = Boolean(projectId);
  const status = (done: boolean): SummaryStatus => (done ? "done" : "todo");
  const statusLabel = (done: boolean) => (done ? t("complete") : t("incomplete"));
  const hasName = Boolean(name.trim());
  const firstGoal = goals
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .find(Boolean);
  const selectedSpecialists = specialists.filter((a) => memberIds.includes(a.id));
  const chosenManager = managers.find((a) => a.id === managerId);
  const teamSummary = [chosenManager?.name ?? t("teamManagerSummary"), ...selectedSpecialists.map((a) => a.name)].join(
    ", ",
  );
  const budgetValue = budget.trim();
  const limitsSummary = [
    budgetValue ? t("budgetSummary", { budget: budgetValue }) : t("noBudget"),
    allowed.length
      ? providers
          .filter((p) => allowed.includes(p.id))
          .map((p) => p.label)
          .join(", ")
      : t("allProviders"),
  ].join(" · ");
  const telegramSummary = topic.trim() ? t("topicSummary", { topic: topic.trim() }) : t("topicNotSet");
  const sandboxSummary = sandboxDefault
    ? sandbox
      ? ts("summaryCustom", { policy: policySummary.policy(sandbox) })
      : ts("summaryDefault", { policy: policySummary.policy(sandboxDefault) })
    : "";
  function setSandboxSource(source: "default" | "custom") {
    if (source === "default") {
      if (sandbox) customSandbox.current = sandbox;
      setSandbox(null);
    } else if (!sandbox && sandboxDefault) setSandbox(customSandbox.current ?? sandboxDefault);
  }

  const submitButton = (className?: string) => (
    <Button type="submit" form={FORM_ID} disabled={pending} className={className}>
      {pending ? <Spinner /> : <SaveIcon />}
      {editing ? tc("actions.save") : t("submitCreate")}
    </Button>
  );
  const cancelButton = (
    <Button type="button" variant="ghost" asChild>
      <Link href={projectId ? `/projects/${projectId}` : "/projects"}>{tc("actions.cancel")}</Link>
    </Button>
  );
  const formError = error && !error.field && (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  );

  return (
    <FormPage
      as="div"
      guard={dirty && !pending}
      identity={{ name: name.trim(), untitled: t("untitled"), subtitle: description.trim() || t("noDescription") }}
      // In settings the name above the sections is the only place that names the project.
      identityInRail={!editing}
      summary={
        <SummaryList label={t("summaryLabel")}>
          <SummaryItem
            target={SECTIONS.identity}
            status={status(hasName)}
            statusLabel={statusLabel(hasName)}
            label={t("identityTitle")}
          >
            {hasName ? null : t("nameMissing")}
          </SummaryItem>
          <SummaryItem
            target={SECTIONS.goals}
            status={status(Boolean(firstGoal))}
            statusLabel={statusLabel(Boolean(firstGoal))}
            label={t("goalsTitle")}
          >
            <span title={firstGoal}>{firstGoal ?? t("goalsMissing")}</span>
          </SummaryItem>
          {!editing && (
            <SummaryItem target={SECTIONS.team} status="info" label={t("teamTitle")}>
              <span title={teamSummary}>{teamSummary}</span>
            </SummaryItem>
          )}
          <SummaryItem target={SECTIONS.limits} status="info" label={t("limitsTitle")} onSelect={() => setLimitsOpen(true)}>
            <span title={limitsSummary}>{limitsSummary}</span>
          </SummaryItem>
          {sandboxDefault && (
            <SummaryItem target={SECTIONS.sandbox} status="info" label={ts("title")} onSelect={() => setSandboxOpen(true)}>
              <span title={sandboxSummary}>{sandboxSummary}</span>
            </SummaryItem>
          )}
          <SummaryItem
            target={SECTIONS.telegram}
            status="info"
            label={t("telegramTitle")}
            onSelect={() => setTelegramOpen(true)}
          >
            {telegramSummary}
          </SummaryItem>
        </SummaryList>
      }
      alert={formError}
      submit={submitButton}
      cancel={cancelButton}
    >
      <form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-5">
        <section id={SECTIONS.identity} aria-label={t("identityTitle")} className="mb-2 flex scroll-mt-20 flex-col gap-0.5">
          <label htmlFor="project-name" className="sr-only">
            {t("nameLabel")}
          </label>
          <input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            required
            minLength={2}
            autoFocus={!editing}
            autoComplete="off"
            className={cn(heroFieldVariants({ kind: "title" }), "text-2xl sm:text-3xl")}
          />
          <label htmlFor="project-description" className="sr-only">
            {t("descriptionLabel")}
          </label>
          <textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPlaceholder")}
            rows={2}
            className={cn(
              heroFieldVariants({ kind: "subtitle" }),
              "field-sizing-content max-h-48 resize-none py-1 text-base text-pretty",
            )}
          />
        </section>

        <FormSection id={SECTIONS.goals} icon={TargetIcon} title={t("goalsTitle")} description={t("goalsDescription")}>
          <Textarea
            id="project-goals"
            aria-label={t("goalsTitle")}
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            placeholder={t("goalsPlaceholder")}
            className="min-h-28 resize-none px-3 py-2.5 leading-relaxed"
          />
        </FormSection>

        {!editing && (
          <FormSection id={SECTIONS.team} icon={UsersIcon} title={t("teamTitle")} description={t("teamDescription")}>
            {managers.length ? (
              <FormSubsection title={t("managerTitle")} description={t("managerHint")}>
                <div role="radiogroup" aria-label={t("managerTitle")} className="flex flex-wrap gap-2">
                  {managers.map((a) => (
                    <AgentChip
                      key={a.id}
                      agent={a}
                      single
                      selected={managerId === a.id}
                      onSelectedChange={(on) => setManagerId(on ? a.id : null)}
                    />
                  ))}
                </div>
              </FormSubsection>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 dark:bg-primary/10">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/15">
                  <CrownIcon className="size-4" aria-hidden />
                </span>
                <p className="min-w-0 text-sm text-pretty">{t("managerAuto")}</p>
              </div>
            )}
            <FormSubsection
              title={t("specialistsTitle")}
              count={memberIds.length}
              description={specialists.length ? t("specialistsDescription") : undefined}
            >
              {specialists.length ? (
                <div role="group" aria-label={t("specialistsTitle")} className="flex flex-wrap gap-2">
                  {specialists.map((a) => (
                    <AgentChip
                      key={a.id}
                      agent={a}
                      selected={memberIds.includes(a.id)}
                      onSelectedChange={(on) => setMemberIds((l) => toggle(l, a.id, on))}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("noSpecialists")}</p>
              )}
            </FormSubsection>
          </FormSection>
        )}

        <FormSectionCollapsible
          id={SECTIONS.limits}
          icon={GaugeIcon}
          title={t("limitsTitle")}
          summary={limitsSummary}
          open={limitsOpen}
          onOpenChange={setLimitsOpen}
        >
          <Field data-invalid={error?.field === "budget" || undefined}>
            <FieldLabel htmlFor="project-budget">{t("budgetLabel")}</FieldLabel>
            <Input
              id="project-budget"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder={t("budgetPlaceholder")}
              aria-invalid={error?.field === "budget" || undefined}
              className="tabular max-w-48"
            />
            {error?.field === "budget" && <FieldError>{error.message}</FieldError>}
          </Field>
          <FormSubsection title={t("providersLabel")} description={t("providersHint")}>
            <div role="group" aria-label={t("providersLabel")} className="flex flex-wrap gap-2">
              {providers.map((p) => (
                <SelectableChip
                  key={p.id}
                  selected={allowed.includes(p.id)}
                  onSelectedChange={(on) => setAllowed((l) => toggle(l, p.id, on))}
                >
                  {p.label}
                </SelectableChip>
              ))}
            </div>
          </FormSubsection>
        </FormSectionCollapsible>

        {sandboxDefault && (
          <FormSectionCollapsible
            id={SECTIONS.sandbox}
            icon={BoxesIcon}
            title={ts("title")}
            summary={sandboxSummary}
            open={sandboxOpen}
            onOpenChange={setSandboxOpen}
          >
            <OptionCards
              name="project-sandbox-source"
              label={ts("title")}
              value={sandbox ? "custom" : "default"}
              onValueChange={setSandboxSource}
              options={[
                {
                  value: "default",
                  icon: SparklesIcon,
                  title: ts("followDefault"),
                  description: policySummary.policy(sandboxDefault),
                },
                {
                  value: "custom",
                  icon: SlidersHorizontalIcon,
                  title: ts("custom"),
                  description: ts("customDescription"),
                },
              ]}
            />
            {sandbox ? (
              <SandboxPolicyEditor name="project-sandbox" value={sandbox} onChange={setSandbox} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {ts.rich("defaultHint", {
                  link: (chunks) => (
                    <Link href="/settings/sandbox" className="underline underline-offset-2">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            )}
          </FormSectionCollapsible>
        )}

        <FormSectionCollapsible
          id={SECTIONS.telegram}
          icon={SendIcon}
          title={t("telegramTitle")}
          summary={telegramSummary}
          open={telegramOpen}
          onOpenChange={setTelegramOpen}
        >
          <Field data-invalid={error?.field === "topic" || undefined}>
            <FieldLabel htmlFor="project-topic">{t("topicLabel")}</FieldLabel>
            <Input
              id="project-topic"
              inputMode="numeric"
              value={topic}
              onChange={(e) => setTopic(e.target.value.replace(/[^\d-]/g, ""))}
              placeholder={t("topicPlaceholder")}
              aria-invalid={error?.field === "topic" || undefined}
              className="tabular max-w-48"
            />
            {error?.field === "topic" ? (
              <FieldError>{error.message}</FieldError>
            ) : (
              <FieldDescription>{t("topicHint")}</FieldDescription>
            )}
          </Field>
        </FormSectionCollapsible>
      </form>
      {footer}
    </FormPage>
  );
}

/**
 * A toggle pill for one agent: its avatar and name, check mark when assigned; the role shows on hover.
 * `single`: one of a radio group (picking it again clears the choice).
 */
function AgentChip({
  agent,
  selected,
  onSelectedChange,
  single = false,
}: {
  agent: JoinableAgent;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  single?: boolean;
}) {
  const chip = (
    <button
      type="button"
      {...(single ? { role: "radio", "aria-checked": selected } : { "aria-pressed": selected })}
      onClick={() => onSelectedChange(!selected)}
      className={chipVariants({ selected, className: "max-w-64 pl-1.5" })}
    >
      <AgentAvatar avatar={agent.avatar} size="xs" className="rounded-full" />
      <span className="min-w-0 truncate">{agent.name}</span>
      {selected ? <CheckIcon className="text-primary" aria-hidden /> : <PlusIcon aria-hidden />}
    </button>
  );
  if (!agent.role) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-72">{agent.role}</TooltipContent>
    </Tooltip>
  );
}

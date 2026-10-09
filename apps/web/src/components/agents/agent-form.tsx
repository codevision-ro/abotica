"use client";

import type { ToolPermissions } from "@abotica/core/agents/permissions";
import { AGENT_NAME_MAX_LENGTH, AGENT_PROMPT_MAX_LENGTH, AGENT_ROLE_MAX_LENGTH } from "@abotica/core/limits";
import { modelRole, roleDefaultEffort, roleDefaultModels } from "@abotica/core/models/model-role";
import type { ReasoningEffort } from "@abotica/core/models/reasoning";
import { SETTINGS_LIMITS } from "@abotica/core/settings";
import type { AgentKind } from "@abotica/db";
import type { AgentAvatar as AgentAvatarValue } from "@abotica/db/avatar";
import {
  BlocksIcon,
  CpuIcon,
  CrownIcon,
  NetworkIcon,
  PencilIcon,
  PencilLineIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/app/agent-avatar";
import { FormPage } from "@/components/app/form-page";
import { FormSection, FormSectionCollapsible, FormSubsection } from "@/components/app/form-section";
import { heroFieldVariants } from "@/components/app/hero-fields";
import { OptionCards } from "@/components/app/option-cards";
import { chipVariants, SelectableChip } from "@/components/app/selectable-chip";
import { SummaryItem, SummaryList, type SummaryStatus } from "@/components/app/summary-rail";
import { SettingsNumberField } from "@/components/settings/settings-number-field";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { cn } from "@/lib/utils";
import { createAgent, updateAgent } from "@/server/actions/agents";
import type { AgentFormOptions } from "@/server/queries/agents";
import { AvatarPicker } from "./avatar-picker";
import { chainLabel, ModelChainEditor, type ModelRef } from "./model-chain-editor";
import { ModelMeta, ModelPicker } from "./model-picker";
import { AgentToolsSection } from "./agent-tools-section";
import { ReasoningEffortControl } from "./reasoning-effort-control";

export type AgentFormInitial = {
  name: string;
  role: string;
  avatar: AgentAvatarValue;
  /** Its place in the hierarchy; the form keeps it, the server enforces which changes are allowed. */
  kind: AgentKind;
  /** A specialist's instructions, or additional instructions for a manager or the super agent. */
  systemPrompt: string;
  /** Null provider and model: the agent follows the default models from settings. */
  provider: string | null;
  model: string | null;
  fallbacks: ModelRef[];
  reasoningEffort: ReasoningEffort;
  permissions: ToolPermissions;
  limits: { maxSteps: number; timeoutMs: number; budgetUsd: number | null };
  skillIds: string[];
  mcpServerIds: string[];
  projectIds: string[];
};

type Mode = { kind: "create"; templateSlug?: string } | { kind: "edit"; agentId: string };

/** Section ids: scroll targets of the summary rail. */
const SECTIONS = {
  identity: "agent-identity",
  kind: "agent-position",
  instructions: "agent-instructions",
  model: "agent-model",
  tools: "agent-tools",
  skills: "agent-skills",
  advanced: "agent-advanced",
} as const;

/** Bounds of an agent's limits, the same as those of the default limits in Settings > Agents. */
const LIMITS = SETTINGS_LIMITS.agents;

/** Permission keys sorted, so undoing a change makes the form clean again. */
const sortedKeys = (obj: ToolPermissions) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

const toggle = (list: string[], item: string, on: boolean) =>
  on ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item);

export function AgentForm({
  mode,
  initial,
  options,
  isTemplate = false,
}: {
  mode: Mode;
  initial: AgentFormInitial;
  options: AgentFormOptions;
  /** Templates are blueprints: like the super agent, they never join a project. */
  isTemplate?: boolean;
}) {
  const t = useTranslations("agents.form");
  const tv = useTranslations("agents.validation");
  const te = useTranslations("agents.effort");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [v, setValues] = useState(initial);
  // NaN while a field does not hold a number; the budget is null for no limit.
  const [maxSteps, setMaxSteps] = useState(initial.limits.maxSteps);
  const [timeoutMin, setTimeoutMin] = useState(Math.round(initial.limits.timeoutMs / 60_000));
  const [budget, setBudget] = useState(initial.limits.budgetUsd);
  const [note, setNote] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const snapshot = (n = note) => [{ ...v, permissions: sortedKeys(v.permissions) }, maxSteps, timeoutMin, budget, n];
  const { dirty, markSaved } = useDirtySnapshot(snapshot());
  // Remembers the explicit model chain while "use default" is on, so switching back restores it.
  const explicitModel = useRef<Pick<AgentFormInitial, "provider" | "model" | "fallbacks"> | null>(
    initial.provider ? { provider: initial.provider, model: initial.model, fallbacks: initial.fallbacks } : null,
  );
  const usesDefault = !v.provider;
  // "Default" means the default of the agent's role: the super agent's, the managers' or the agents'.
  const role = modelRole(v);
  const defaultChain = roleDefaultModels(options, role);
  const setUsesDefault = (on: boolean) => {
    if (on && v.provider) explicitModel.current = { provider: v.provider, model: v.model, fallbacks: v.fallbacks };
    const restored = explicitModel.current ?? {
      provider: options.providers.find((p) => p.configured)?.id ?? "deepseek",
      model: "",
      fallbacks: [],
    };
    setValues((prev) => (on ? { ...prev, provider: null, model: null, fallbacks: [] } : { ...prev, ...restored }));
  };

  const set = <K extends keyof AgentFormInitial>(key: K, value: AgentFormInitial[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const provider = options.providers.find((p) => p.id === v.provider);
  const selectedModel = options.models.find((m) => m.provider === v.provider && m.id === v.model);
  const primary = usesDefault ? defaultChain[0] : { provider: v.provider, model: v.model };
  const primaryModel = options.models.find((m) => m.provider === primary?.provider && m.id === primary?.model);
  const link = (href: string) =>
    function RichLink(chunks: React.ReactNode) {
      return (
        <Link href={href} className="underline underline-offset-2">
          {chunks}
        </Link>
      );
    };

  const inheritedEffort = { effort: roleDefaultEffort(options, role), source: te("sources.settings") };
  const inheritedLabel =
    inheritedEffort.effort === "default"
      ? te("inheritModel")
      : te("inheritFrom", { source: inheritedEffort.source, effort: te(`options.${inheritedEffort.effort}.label`) });
  const advancedSummary = [
    !usesDefault && t("fallbackCount", { count: v.fallbacks.length }),
    t("effortSummary", {
      effort: v.reasoningEffort === "default" ? inheritedLabel : te(`options.${v.reasoningEffort}.label`),
    }),
    t("limitsSummary", {
      steps: Number.isNaN(maxSteps) ? "?" : maxSteps,
      minutes: Number.isNaN(timeoutMin) ? "?" : timeoutMin,
    }),
    budget !== null ? t("budgetSummary", { budget: Number.isNaN(budget) ? "?" : budget }) : t("noBudget"),
  ]
    .filter(Boolean)
    .join(" · ");
  const modelSummary = usesDefault
    ? defaultChain.length
      ? t("defaultSummary", { chain: chainLabel(defaultChain.slice(0, 1)) })
      : t("defaultNotSet")
    : v.model
      ? `${v.provider}/${v.model}`
      : t("noModel");
  // Integrations the agent gets: the global ones and those assigned to it.
  const integrationCount = options.mcpServers.filter((s) => s.global || v.mcpServerIds.includes(s.id)).length;

  const editing = mode.kind === "edit";

  function submit() {
    // Problems in the advanced section open it, so the field in question is visible.
    const advancedError = (message: string) => {
      setAdvancedOpen(true);
      toast.error(message);
    };
    const within = (n: number, range: { min: number; max: number }) => n >= range.min && n <= range.max;
    if (!Number.isInteger(maxSteps) || !within(maxSteps, LIMITS.maxSteps)) {
      return advancedError(tv("maxSteps", LIMITS.maxSteps));
    }
    if (!Number.isFinite(timeoutMin) || !within(timeoutMin, LIMITS.timeoutMinutes)) {
      return advancedError(tv("timeout", LIMITS.timeoutMinutes));
    }
    if (budget !== null && (!Number.isFinite(budget) || !within(budget, LIMITS.budgetUsd))) {
      return advancedError(tv("budget", LIMITS.budgetUsd));
    }
    if (!usesDefault && !v.model?.trim()) return toast.error(t("pickModel"));
    if (v.fallbacks.some((f) => !f.model.trim())) return advancedError(t("fallbackModel"));

    const payload = {
      ...v,
      // Only a specialist's teams are edited here: a manager's projects are those it leads, set in their Team tab.
      projectIds: v.kind === "specialist" ? v.projectIds : initial.projectIds,
      limits: { maxSteps, timeoutMs: Math.round(timeoutMin * 60_000), budgetUsd: budget },
    };

    startTransition(async () => {
      if (mode.kind === "create") {
        const res = await createAgent({ ...payload, templateSlug: mode.templateSlug });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("created"));
        markSaved();
        router.push(`/agents/${res.data.id}`);
      } else {
        const res = await updateAgent({ ...payload, id: mode.agentId, note: note.trim() || undefined });
        if (!res.ok) return void toast.error(res.error);
        toast.success(t("saved"));
        setNote("");
        markSaved(snapshot(""));
        router.refresh();
      }
    });
  }

  // A specialist's prompt is required; a manager's or the super agent's is optional extra instructions.
  const profession = v.kind === "specialist";
  const promptTitle = profession ? t("instructionsTitle") : t("additionalTitle");
  const promptDone = Boolean(v.systemPrompt.trim());
  // The position is chosen once, when the agent is created; the super agent is never created here.
  const choosesKind = !editing && v.kind !== "orchestrator";
  // A manager's projects are the ones it leads, shown here and changed in each project's Team tab.
  const leads = v.kind === "manager" && !isTemplate;
  const ledProjects = editing ? options.projects.filter((p) => p.managerAgentId === mode.agentId) : [];
  // Only specialists join teams here: a manager joins the projects it leads, from their Team tab.
  const joinsProjects = v.kind === "specialist" && !isTemplate;
  const projectItems = options.projects.map((p) => {
    // A project the agent manages keeps it: the manager changes in the project's Team tab first.
    const manages = editing && p.managerAgentId === mode.agentId;
    return { id: p.id, label: p.name, hint: manages ? t("managesProject") : undefined, locked: manages };
  });
  const submitLabel = editing ? tc("save") : t("create");
  const submitButton = (className?: string) => (
    <Button type="submit" disabled={pending} className={className}>
      {pending ? <Spinner /> : <SaveIcon />}
      {submitLabel}
    </Button>
  );
  const cancelLink = mode.kind === "create" && (
    <Button type="button" variant="ghost" asChild>
      <Link href="/agents">{tc("cancel")}</Link>
    </Button>
  );
  const status = (done: boolean): SummaryStatus => (done ? "done" : "todo");
  const statusLabel = (done: boolean) => (done ? t("complete") : t("incomplete"));
  const modelDone = usesDefault ? defaultChain.length > 0 : Boolean(v.model?.trim());

  return (
    <FormPage
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      guard={dirty && !pending}
      identity={{
        name: v.name.trim(),
        untitled: t("untitled"),
        subtitle: v.role.trim() || t("noRole"),
        media: (size) => <AgentAvatar avatar={v.avatar} size={size} />,
      }}
      // On edit the page header shows who the agent is and the form is one column; the rail guides a new agent.
      summary={
        editing ? undefined : (
          <SummaryList label={t("summaryLabel")}>
            <SummaryItem
              target={SECTIONS.identity}
              status={status(Boolean(v.name.trim()))}
              statusLabel={statusLabel(Boolean(v.name.trim()))}
              label={t("identityTitle")}
            >
              {v.name.trim() ? null : t("nameMissing")}
            </SummaryItem>
            {choosesKind && (
              <SummaryItem target={SECTIONS.kind} status="info" label={t("kindTitle")}>
                {t(`kinds.${v.kind}.title`)}
              </SummaryItem>
            )}
            {/* Additional instructions are optional: left empty, nothing is missing. */}
            {profession ? (
              <SummaryItem
                target={SECTIONS.instructions}
                status={status(promptDone)}
                statusLabel={statusLabel(promptDone)}
                label={promptTitle}
              >
                {promptDone ? t("characters", { count: v.systemPrompt.length }) : t("promptMissing")}
              </SummaryItem>
            ) : (
              <SummaryItem target={SECTIONS.instructions} status="info" label={promptTitle}>
                {promptDone ? t("characters", { count: v.systemPrompt.length }) : t("additionalNone")}
              </SummaryItem>
            )}
            <SummaryItem
              target={SECTIONS.model}
              status={status(modelDone)}
              statusLabel={statusLabel(modelDone)}
              label={t("modelTitle")}
            >
              <span className="font-mono" title={modelSummary}>
                {modelSummary}
              </span>
            </SummaryItem>
            <SummaryItem target={SECTIONS.tools} status="info" label={t("toolsTitle")}>
              {t("integrationCount", { count: integrationCount })}
            </SummaryItem>
            <SummaryItem target={SECTIONS.skills} status="info" label={t("skills")}>
              {t("selectedCount", { count: v.skillIds.length })}
            </SummaryItem>
            {joinsProjects && (
              <SummaryItem target={SECTIONS.skills} status="info" label={t("projects")}>
                {t("selectedCount", { count: v.projectIds.length })}
              </SummaryItem>
            )}
            <SummaryItem
              target={SECTIONS.advanced}
              status="info"
              label={t("advancedTitle")}
              onSelect={() => setAdvancedOpen(true)}
            >
              <span title={advancedSummary}>{advancedSummary}</span>
            </SummaryItem>
          </SummaryList>
        )
      }
      // The note goes with the version a save creates: asked for only once there is something to save.
      versionNote={
        editing && dirty
          ? { value: note, onChange: setNote, placeholder: t("versionNote"), label: t("versionNoteAria") }
          : undefined
      }
      submit={submitButton}
      cancel={cancelLink}
      status={editing ? (dirty ? t("unsaved") : t("noChanges")) : undefined}
    >
      <section
        id={SECTIONS.identity}
        aria-label={t("identityTitle")}
        className={cn("mb-2 flex scroll-mt-20 items-center", editing ? "gap-4" : "gap-4 sm:gap-5")}
      >
        <AvatarPicker value={v.avatar} onChange={(avatar) => set("avatar", avatar)}>
          <button
            type="button"
            aria-label={t("changeAvatar")}
            className="group/avatar relative shrink-0 rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* Smaller in edit mode, where the page header already names the agent. */}
            <AgentAvatar
              avatar={v.avatar}
              size={editing ? "xl" : "2xl"}
              className={cn(
                "transition-transform group-hover/avatar:scale-[1.03]",
                !editing && "sm:size-20 sm:rounded-[1.25rem] sm:[&_svg]:size-10!",
              )}
            />
            <span
              className={cn(
                "absolute flex items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors group-hover/avatar:text-foreground",
                editing ? "-right-1 -bottom-1 size-5" : "-right-1.5 -bottom-1.5 size-7",
              )}
            >
              <PencilIcon className={editing ? "size-2.5" : "size-3.5"} aria-hidden />
            </span>
          </button>
        </AvatarPicker>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor="agent-name" className="sr-only">
            {t("name")}
          </label>
          <input
            id="agent-name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            required
            maxLength={AGENT_NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder={t("namePlaceholder")}
            className={cn(heroFieldVariants({ kind: "title" }), editing ? "text-lg" : "text-2xl sm:text-3xl")}
          />
          <label htmlFor="agent-role" className="sr-only">
            {t("role")}
          </label>
          <input
            id="agent-role"
            value={v.role}
            onChange={(e) => set("role", e.target.value)}
            maxLength={AGENT_ROLE_MAX_LENGTH}
            autoComplete="off"
            placeholder={t("rolePlaceholder")}
            className={cn(heroFieldVariants({ kind: "subtitle" }), editing ? "py-0.5 text-sm" : "py-1 text-base")}
          />
        </div>
      </section>

      {choosesKind && (
        <FormSection id={SECTIONS.kind} icon={NetworkIcon} title={t("kindTitle")} description={t("kindDescription")}>
          <OptionCards
            name="agent-kind"
            label={t("kindTitle")}
            value={v.kind === "manager" ? "manager" : "specialist"}
            onValueChange={(kind) => set("kind", kind)}
            options={[
              {
                value: "specialist",
                icon: UsersIcon,
                title: t("kinds.specialist.title"),
                description: t("kinds.specialist.description"),
              },
              {
                value: "manager",
                icon: CrownIcon,
                title: t("kinds.manager.title"),
                description: t("kinds.manager.description"),
              },
            ]}
          />
        </FormSection>
      )}

      <FormSection
        id={SECTIONS.instructions}
        icon={PencilLineIcon}
        title={promptTitle}
        description={profession ? t("instructionsDescription") : t("additionalDescription")}
      >
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/20">
          <Textarea
            id="agent-prompt"
            aria-label={profession ? t("systemPrompt") : t("additionalPrompt")}
            value={v.systemPrompt}
            onChange={(e) => set("systemPrompt", e.target.value)}
            maxLength={AGENT_PROMPT_MAX_LENGTH}
            placeholder={profession ? t("promptPlaceholder") : undefined}
            spellCheck={false}
            className="max-h-[60vh] min-h-44 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
            <span>{profession ? t("systemPrompt") : t("additionalPrompt")}</span>
            <span className="tabular">{t("characters", { count: v.systemPrompt.length })}</span>
          </div>
        </div>
      </FormSection>

      <FormSection id={SECTIONS.model} icon={CpuIcon} title={t("modelTitle")} description={t("modelDescription")}>
        <OptionCards
          name="agent-model-source"
          label={t("modelTitle")}
          value={usesDefault ? "default" : "custom"}
          onValueChange={(choice) => setUsesDefault(choice === "default")}
          options={[
            {
              value: "default",
              icon: SparklesIcon,
              title: t("useDefault"),
              description: defaultChain.length ? (
                <span className="font-mono wrap-anywhere">{chainLabel(defaultChain)}</span>
              ) : (
                <span className="text-warning">{t("defaultNotSet")}</span>
              ),
            },
            {
              value: "custom",
              icon: SlidersHorizontalIcon,
              title: t("useCustom"),
              description: t("useCustomDescription"),
            },
          ]}
        />

        {usesDefault ? (
          defaultChain.length ? (
            <p className="text-xs text-muted-foreground">
              {t.rich("defaultHint", { role, link: link("/settings/models") })}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
              {t.rich("defaultMissing", { link: link("/settings/models") })}
            </p>
          )
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <Field>
              <FieldLabel htmlFor="agent-provider">{t("provider")}</FieldLabel>
              <Select
                value={v.provider ?? ""}
                onValueChange={(p) => setValues((prev) => ({ ...prev, provider: p, model: "" }))}
              >
                <SelectTrigger id="agent-provider" className="w-full">
                  <SelectValue placeholder={t("providerPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {options.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.configured}>
                      {p.label}
                      {!p.configured && <span className="text-xs text-muted-foreground">{t("noKey")}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {provider && !provider.configured && (
                <FieldDescription className="flex items-center gap-1.5 text-warning">
                  <TriangleAlertIcon className="size-3.5" />
                  {t.rich("providerMissingKey", { link: link("/settings/models") })}
                </FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-model">{t("model")}</FieldLabel>
              <ModelPicker
                id="agent-model"
                provider={v.provider ?? ""}
                value={v.model ?? ""}
                onChange={(m) => set("model", m)}
                models={options.models}
              />
              <FieldDescription>
                {selectedModel ? <ModelMeta model={selectedModel} /> : v.model ? t("outsideCatalog") : null}
              </FieldDescription>
            </Field>
          </div>
        )}
      </FormSection>

      <AgentToolsSection
        id={SECTIONS.tools}
        permissions={v.permissions}
        setPermissions={(fn) => setValues((prev) => ({ ...prev, permissions: fn(prev.permissions) }))}
        mcpServerIds={v.mcpServerIds}
        setMcpServerIds={(ids) => set("mcpServerIds", ids)}
        servers={options.mcpServers}
        subject={{ kind: v.kind }}
      />

      <FormSection
        id={SECTIONS.skills}
        icon={BlocksIcon}
        title={joinsProjects || leads ? t("skillsProjectsTitle") : t("skills")}
        description={
          joinsProjects ? t("skillsProjectsDescription") : leads ? t("skillsLedDescription") : t("skillsDescription")
        }
      >
        <ChipPicker
          title={t("skills")}
          description={t("skillsDescription")}
          items={options.skills.map((s) => ({ id: s.id, label: s.name, hint: s.description }))}
          selected={v.skillIds}
          onChange={(ids) => set("skillIds", ids)}
          empty={t.rich("noSkills", { link: link("/skills") })}
        />
        {joinsProjects && (
          <ChipPicker
            title={t("projects")}
            description={t("projectsDescription")}
            items={projectItems}
            selected={v.projectIds}
            onChange={(ids) => set("projectIds", ids)}
            empty={t.rich("noProjects", { link: link("/projects") })}
          />
        )}
        {leads && (
          <FormSubsection
            title={t("ledProjects")}
            count={ledProjects.length}
            description={ledProjects.length ? t("ledProjectsDescription") : undefined}
          >
            {ledProjects.length ? (
              <div className="flex flex-wrap gap-2">
                {ledProjects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}?tab=team`}
                    title={p.name}
                    className={chipVariants({ selected: true, className: "max-w-64 hover:border-primary/60" })}
                  >
                    <CrownIcon className="text-primary" aria-hidden />
                    <span className="min-w-0 truncate">{p.name}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t.rich("ledNone", { link: link("/projects") })}</p>
            )}
          </FormSubsection>
        )}
      </FormSection>

      <FormSectionCollapsible
        id={SECTIONS.advanced}
        icon={SlidersHorizontalIcon}
        title={t("advancedTitle")}
        summary={advancedSummary}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
      >
        {!usesDefault && (
          <FormSubsection title={t("fallbackChain")} description={t("fallbackDescription")}>
            <ModelChainEditor value={v.fallbacks} onChange={(next) => set("fallbacks", next)} options={options} />
          </FormSubsection>
        )}
        <ReasoningEffortControl
          value={v.reasoningEffort}
          onChange={(effort) => set("reasoningEffort", effort ?? "default")}
          support={primaryModel ? primaryModel.reasoning : undefined}
          modelName={primaryModel?.name ?? primary?.model ?? ""}
          inherited={inheritedEffort}
        />
        <FormSubsection title={t("limitsTitle")} description={t("limitsDescription")}>
          <SettingsNumberField
            id="limit-steps"
            label={t("maxSteps")}
            value={maxSteps}
            onChange={setMaxSteps}
            min={LIMITS.maxSteps.min}
            max={LIMITS.maxSteps.max}
            step={1}
          />
          <SettingsNumberField
            id="limit-timeout"
            label={t("timeout")}
            value={timeoutMin}
            onChange={setTimeoutMin}
            min={LIMITS.timeoutMinutes.min}
            max={LIMITS.timeoutMinutes.max}
            step={1}
            unit={t("minutesUnit")}
          />
          <SettingsNumberField
            id="limit-budget"
            nullable
            decimal
            label={t("budget")}
            value={budget}
            onChange={setBudget}
            placeholder={t("unlimited")}
            unit="USD"
          />
        </FormSubsection>
      </FormSectionCollapsible>
    </FormPage>
  );
}

/** Pills to pick items from a list; the hint shows on hover. A locked item stays as it is. */
function ChipPicker({
  title,
  description,
  items,
  selected,
  onChange,
  empty,
}: {
  title: string;
  description: string;
  items: { id: string; label: string; hint?: string; locked?: boolean }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  empty: React.ReactNode;
}) {
  return (
    <FormSubsection title={title} count={selected.length} description={items.length ? description : undefined}>
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const chip = (
              <SelectableChip
                key={item.id}
                selected={selected.includes(item.id)}
                onSelectedChange={(on) => {
                  if (!item.locked) onChange(toggle(selected, item.id, on));
                }}
                // Not `disabled`: a disabled button shows no tooltip, and the tooltip says why it is locked.
                aria-disabled={item.locked || undefined}
                className={cn("max-w-64", item.locked && "cursor-not-allowed")}
              >
                {item.label}
              </SelectableChip>
            );
            return item.hint ? (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>{chip}</TooltipTrigger>
                <TooltipContent className="max-w-72">{item.hint}</TooltipContent>
              </Tooltip>
            ) : (
              chip
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </FormSubsection>
  );
}

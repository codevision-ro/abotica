"use client";

import type { ModelRole, ModelSettings } from "@abotica/core/settings";
import type { ReasoningEffort } from "@abotica/core/models/reasoning";
import { CrownIcon, Layers, type LucideIcon, PlusIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSection, FormSubsection } from "@/components/app/form-section";
import { chainLabel, ModelChainEditor, type ModelRef } from "@/components/agents/model-chain-editor";
import { type InheritedEffort, ReasoningEffortControl } from "@/components/agents/reasoning-effort-control";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import type { AgentFormOptions } from "@/server/queries/agents";

export type ChainOptions = Pick<AgentFormOptions, "providers" | "models">;

type RoleDefaults = Pick<ModelSettings, "chains" | "reasoningEffort">;

type SectionProps = {
  value: RoleDefaults;
  onChange: (patch: {
    chains?: Partial<ModelSettings["chains"]>;
    reasoningEffort?: Partial<ModelSettings["reasoningEffort"]>;
  }) => void;
  /** The problem of each role's chain, if any. */
  errors: Partial<Record<ModelRole, string>>;
  options: ChainOptions;
  /** Agents on "default" per role. */
  inheritingAgents: Record<ModelRole, number>;
};

/**
 * The default model, up front: what every agent without a model of its own runs on (the specialists'
 * chain, which the managers and the super agent follow while theirs are empty). Controlled: the models
 * form saves it with the rest of the page (ModelsSettingsForm).
 */
export function DefaultModelSection({ value, onChange, errors, options, inheritingAgents }: SectionProps) {
  const t = useTranslations("settings.defaultModels");
  const { chains, reasoningEffort } = value;
  const agentsChain = chains.agent.filter((m) => m.model.trim());
  // The specialists' default also serves the roles whose chain is empty.
  const agentsUsing =
    inheritingAgents.agent +
    (chains.manager.length ? 0 : inheritingAgents.manager) +
    (chains.orchestrator.length ? 0 : inheritingAgents.orchestrator);
  const description = agentsUsing > 0 ? `${t("description")} ${t("inheriting", { count: agentsUsing })}` : t("description");

  return (
    <FormSection id="default-models" icon={Layers} title={t("title")} description={description}>
      <ModelChainEditor
        value={chains.agent}
        onChange={(agent) => onChange({ chains: { agent } })}
        options={options}
        primaryFirst
        addLabel={t("addModel")}
      />
      {errors.agent && <FieldError>{errors.agent}</FieldError>}
      <EffortFor
        chain={agentsChain}
        options={options}
        value={reasoningEffort.agent}
        onChange={(next) => onChange({ reasoningEffort: { agent: next ?? "default" } })}
        inherited={{ effort: "default" }}
      />
    </FormSection>
  );
}

/** Own models for the managers and the super agent, each optional: an empty one follows the default model. */
export function RoleOverrides({ value, onChange, errors, options, inheritingAgents }: SectionProps) {
  const t = useTranslations("settings.defaultModels");
  const firstConfigured = options.providers.find((p) => p.configured)?.id ?? "";
  const { chains, reasoningEffort } = value;
  const agentsChain = chains.agent.filter((m) => m.model.trim());
  const agentsEffort: InheritedEffort = { effort: reasoningEffort.agent, source: t("title") };
  const describe = (text: string, count: number) => (count > 0 ? `${text} ${t("inheriting", { count })}` : text);

  return (
    <FormSubsection title={t("rolesTitle")} description={t("rolesDescription")}>
      <div className="flex flex-col gap-3">
        {(["manager", "orchestrator"] as const).map((role) => (
          <RoleDefault
            key={role}
            icon={role === "manager" ? CrownIcon : SparklesIcon}
            title={t(`roles.${role}.title`)}
            description={describe(t(`roles.${role}.description`), inheritingAgents[role])}
            chain={chains[role]}
            onChainChange={(next) => onChange({ chains: { [role]: next } })}
            effort={reasoningEffort[role]}
            onEffortChange={(next) => onChange({ reasoningEffort: { [role]: next } })}
            error={errors[role]}
            agentsChain={agentsChain}
            agentsEffort={agentsEffort}
            firstConfigured={firstConfigured}
            options={options}
          />
        ))}
      </div>
    </FormSubsection>
  );
}

/** One role's models in a card of their own: icon, title and description, then the model chain and the effort. */
function RoleCard({
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/60 dark:bg-background/30">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-3 sm:px-4">
        <span className="row-[1/3] flex size-7 shrink-0 items-center max-sm:self-start justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <h3 className="col-start-2 row-start-1 text-sm font-medium">{title}</h3>
        {/* On a phone the action goes under the description, so a long label does not crowd the title. */}
        {action && (
          <div className="shrink-0 max-sm:col-start-2 max-sm:row-start-3 max-sm:-ml-2.5 sm:col-start-3 sm:row-[1/3]">
            {action}
          </div>
        )}
        <p className="col-[2/-1] row-start-2 text-xs text-pretty text-muted-foreground sm:col-[2/3]">{description}</p>
      </div>
      <div className="flex flex-col gap-4 border-t border-border/60 p-3 sm:p-4">{children}</div>
    </div>
  );
}

/** The effort control for the primary model of `chain`, the one the effort reaches first. */
function EffortFor({
  chain,
  options,
  value,
  onChange,
  inherited,
}: {
  chain: ModelRef[];
  options: ChainOptions;
  value: ReasoningEffort | null;
  onChange: (value: ReasoningEffort | null) => void;
  inherited: InheritedEffort;
}) {
  const primary = chain[0];
  const model = options.models.find((m) => m.provider === primary?.provider && m.id === primary?.model);
  return (
    <ReasoningEffortControl
      value={value}
      onChange={onChange}
      support={model ? model.reasoning : undefined}
      modelName={model?.name ?? primary?.model ?? ""}
      inherited={inherited}
      size="sm"
    />
  );
}

/**
 * A role's defaults, each optional: an empty chain runs on the specialists' models, a null effort follows the
 * specialists' effort.
 */
function RoleDefault({
  icon,
  title,
  description,
  chain,
  onChainChange,
  effort,
  onEffortChange,
  error,
  agentsChain,
  agentsEffort,
  firstConfigured,
  options,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  chain: ModelRef[];
  onChainChange: (next: ModelRef[]) => void;
  effort: ReasoningEffort | null;
  onEffortChange: (next: ReasoningEffort | null) => void;
  error?: string;
  agentsChain: ModelRef[];
  agentsEffort: InheritedEffort;
  firstConfigured: string;
  options: ChainOptions;
}) {
  const t = useTranslations("settings.defaultModels");
  return (
    <RoleCard
      icon={icon}
      title={title}
      description={description}
      action={
        chain.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChainChange([])}>
            <Undo2Icon /> {t("useAgents")}
          </Button>
        )
      }
    >
      {chain.length ? (
        <ModelChainEditor value={chain} onChange={onChainChange} options={options} primaryFirst addLabel={t("addModel")} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium">{t("sameAsAgents")}</p>
            {agentsChain.length > 0 && (
              <p className="font-mono text-xs wrap-anywhere text-muted-foreground">{chainLabel(agentsChain)}</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChainChange([{ provider: firstConfigured, model: "" }])}
          >
            <PlusIcon /> {t("chooseModels")}
          </Button>
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      <EffortFor
        chain={chain.length ? chain.filter((m) => m.model.trim()) : agentsChain}
        options={options}
        value={effort}
        onChange={onEffortChange}
        inherited={agentsEffort}
      />
    </RoleCard>
  );
}

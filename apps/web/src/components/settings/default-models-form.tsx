"use client";

import type { ModelRole } from "@abotica/core/models/model-role";
import type { ReasoningEffort } from "@abotica/core/models/reasoning";
import { CrownIcon, Layers, type LucideIcon, PlusIcon, Save, SparklesIcon, Undo2Icon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { chainLabel, ModelChainEditor, type ModelRef } from "@/components/agents/model-chain-editor";
import { type InheritedEffort, ReasoningEffortControl } from "@/components/agents/reasoning-effort-control";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { updateDefaultModels } from "@/server/actions/settings";
import type { AgentFormOptions } from "@/server/queries/agents";

type ChainOptions = Pick<AgentFormOptions, "providers" | "models">;

type RoleDefaults = Pick<
  AgentFormOptions,
  | "defaultModels"
  | "orchestratorModels"
  | "managerModels"
  | "defaultReasoningEffort"
  | "orchestratorReasoningEffort"
  | "managerReasoningEffort"
>;

/**
 * The defaults by role (see modelRole), from the widest to the narrowest: the agents' chain and effort
 * are required, and the managers and the super agent follow them while theirs are empty. One save for all.
 */
export function DefaultModelsForm({
  initial,
  options,
  inheritingAgents,
}: {
  initial: RoleDefaults;
  options: ChainOptions;
  /** Agents on "default" per role. */
  inheritingAgents: Record<ModelRole, number>;
}) {
  const t = useTranslations("settings.defaultModels");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const firstConfigured = options.providers.find((p) => p.configured)?.id ?? "";
  const [chain, setChain] = useState<ModelRef[]>(
    initial.defaultModels.length ? initial.defaultModels : [{ provider: firstConfigured, model: "" }],
  );
  const [managerChain, setManagerChain] = useState<ModelRef[]>(initial.managerModels);
  const [orchestratorChain, setOrchestratorChain] = useState<ModelRef[]>(initial.orchestratorModels);
  const [effort, setEffort] = useState(initial.defaultReasoningEffort);
  const [managerEffort, setManagerEffort] = useState(initial.managerReasoningEffort);
  const [orchestratorEffort, setOrchestratorEffort] = useState(initial.orchestratorReasoningEffort);
  const [pending, startTransition] = useTransition();
  const agentsChain = chain.filter((m) => m.model.trim());
  // The agents' default also serves the roles whose saved chain is empty.
  const agentsUsing =
    inheritingAgents.agent +
    (initial.managerModels.length ? 0 : inheritingAgents.manager) +
    (initial.orchestratorModels.length ? 0 : inheritingAgents.orchestrator);
  const describe = (text: string, count: number) => (count > 0 ? `${text} ${t("inheriting", { count })}` : text);
  const agentsEffort: InheritedEffort = { effort, source: t("roles.agent.title") };

  function save() {
    if ([...chain, ...managerChain, ...orchestratorChain].some((m) => !m.model.trim())) {
      return void toast.error(t("pickModelEachRow"));
    }
    startTransition(async () => {
      const res = await updateDefaultModels({
        defaultModels: chain,
        managerModels: managerChain,
        orchestratorModels: orchestratorChain,
        defaultReasoningEffort: effort,
        managerReasoningEffort: managerEffort,
        orchestratorReasoningEffort: orchestratorEffort,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved"));
      router.refresh();
    });
  }

  return (
    <FormSection id="default-models" icon={Layers} title={t("title")} description={t("description")}>
      <RoleCard
        icon={UsersIcon}
        title={t("roles.agent.title")}
        description={describe(t("roles.agent.description"), agentsUsing)}
      >
        <ModelChainEditor value={chain} onChange={setChain} options={options} primaryFirst addLabel={t("addModel")} />
        <EffortFor
          chain={agentsChain}
          options={options}
          value={effort}
          onChange={(next) => setEffort(next ?? "default")}
          inherited={{ effort: "default" }}
        />
      </RoleCard>
      <RoleDefault
        icon={CrownIcon}
        title={t("roles.manager.title")}
        description={describe(t("roles.manager.description"), inheritingAgents.manager)}
        chain={managerChain}
        onChainChange={setManagerChain}
        effort={managerEffort}
        onEffortChange={setManagerEffort}
        agentsChain={agentsChain}
        agentsEffort={agentsEffort}
        firstConfigured={firstConfigured}
        options={options}
      />
      <RoleDefault
        icon={SparklesIcon}
        title={t("roles.orchestrator.title")}
        description={describe(t("roles.orchestrator.description"), inheritingAgents.orchestrator)}
        chain={orchestratorChain}
        onChainChange={setOrchestratorChain}
        effort={orchestratorEffort}
        onEffortChange={setOrchestratorEffort}
        agentsChain={agentsChain}
        agentsEffort={agentsEffort}
        firstConfigured={firstConfigured}
        options={options}
      />
      <div className="flex justify-end">
        <Button onClick={save} disabled={pending || !chain.length}>
          {pending ? <Spinner /> : <Save />}
          {tc("save")}
        </Button>
      </div>
    </FormSection>
  );
}

/** One role's defaults in a card of their own: icon, title and description, then the model chain and the effort. */
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
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-pretty text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-4 border-t border-border/60 px-4 py-4">{children}</div>
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
 * A role's defaults, each optional: an empty chain runs on the agents' models, a null effort follows the
 * agents' effort.
 */
function RoleDefault({
  icon,
  title,
  description,
  chain,
  onChainChange,
  effort,
  onEffortChange,
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

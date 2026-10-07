"use client";

import type { ReasoningEffort } from "@abotica/core/models/reasoning";
import { Layers, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection } from "@/components/app/form-section";
import { ModelChainEditor, type ModelRef } from "@/components/agents/model-chain-editor";
import { ReasoningEffortControl } from "@/components/agents/reasoning-effort-control";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { updateDefaultModels } from "@/server/actions/settings";
import type { AgentFormOptions } from "@/server/queries/agents";

export function DefaultModelsForm({
  initial,
  initialEffort,
  options,
  inheritingAgents,
}: {
  initial: ModelRef[];
  initialEffort: ReasoningEffort;
  options: Pick<AgentFormOptions, "providers" | "models">;
  inheritingAgents: number;
}) {
  const t = useTranslations("settings.defaultModels");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [chain, setChain] = useState<ModelRef[]>(
    initial.length ? initial : [{ provider: options.providers.find((p) => p.configured)?.id ?? "", model: "" }],
  );
  const [effort, setEffort] = useState(initialEffort);
  const [pending, startTransition] = useTransition();
  const primary = chain[0];
  const primaryModel = options.models.find((m) => m.provider === primary?.provider && m.id === primary?.model);

  function save() {
    if (chain.some((m) => !m.model.trim())) return void toast.error(t("pickModelEachRow"));
    startTransition(async () => {
      const res = await updateDefaultModels({ defaultModels: chain, defaultReasoningEffort: effort });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved"));
      router.refresh();
    });
  }

  return (
    <FormSection
      id="default-models"
      icon={Layers}
      title={t("title")}
      description={
        <>
          {t("description")}
          {inheritingAgents > 0 && ` ${t("inheriting", { count: inheritingAgents })}`}
        </>
      }
    >
      <ModelChainEditor value={chain} onChange={setChain} options={options} primaryFirst addLabel={t("addModel")} />
      <ReasoningEffortControl
        value={effort}
        onChange={(next) => setEffort(next ?? "default")}
        support={primaryModel ? primaryModel.reasoning : undefined}
        modelName={primaryModel?.name ?? primary?.model ?? ""}
        inherited={{ effort: "default" }}
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

"use client";

import { SANDBOX_LIMITS, SANDBOX_RUNTIMES, type SandboxRuntime, type SandboxSettings } from "@abotica/core/sandbox-policy";
import {
  BoxIcon,
  BoxesIcon,
  ContainerIcon,
  CpuIcon,
  PowerOffIcon,
  SaveIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FormSection, FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { UnsavedChangesGuard } from "@/components/app/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDirtySnapshot } from "@/hooks/use-dirty-snapshot";
import { updateSandboxSettings } from "@/server/actions/sandbox";
import type { SandboxStatusView } from "@/server/queries/sandbox";
import { SandboxPolicyEditor } from "./sandbox-policy-editor";

const ENABLED_ICONS: Record<"on" | "off", LucideIcon> = { on: ContainerIcon, off: PowerOffIcon };

const RUNTIME_ICONS: Record<SandboxRuntime, LucideIcon> = {
  auto: SparklesIcon,
  runc: BoxIcon,
  runsc: ShieldCheckIcon,
};

/** A number field's text, or null when it is not a number within its limits. */
function inRange(text: string, { min, max }: { min: number; max: number }): number | null {
  const n = Number(text.replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Settings > Sandbox form: on or off, default policy, command timeout and container limits; one Save. */
export function SandboxSettingsForm({ initial, status }: { initial: SandboxSettings; status: SandboxStatusView }) {
  const t = useTranslations("sandbox.settings");
  const tc = useTranslations("common.actions");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [defaults, setDefaults] = useState(initial.defaults);
  const [timeout, setTimeoutText] = useState(String(initial.commandTimeoutSec));
  const [runtime, setRuntime] = useState(initial.runtime);
  const [memory, setMemory] = useState(String(initial.memoryMb));
  const [cpus, setCpus] = useState(String(initial.cpus));
  const { dirty, markSaved } = useDirtySnapshot([enabled, defaults, timeout, runtime, memory, cpus]);

  const limits = SANDBOX_LIMITS;
  const timeoutSec = inRange(timeout, limits.commandTimeoutSec);
  const memoryMb = inRange(memory, limits.memoryMb);
  const cpuCount = inRange(cpus, limits.cpus);
  const invalid = timeoutSec === null || memoryMb === null || cpuCount === null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    startTransition(async () => {
      const res = await updateSandboxSettings({
        enabled,
        defaults,
        commandTimeoutSec: timeoutSec,
        runtime,
        memoryMb,
        cpus: cpuCount,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(t("saved"));
      markSaved();
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <UnsavedChangesGuard dirty={dirty && !pending} />

      <FormSection id="sandbox-enabled" icon={BoxesIcon} title={t("enabled.title")} description={t("enabled.description")}>
        <OptionCards
          name="sandbox-enabled"
          label={t("enabled.title")}
          value={enabled ? "on" : "off"}
          onValueChange={(value) => setEnabled(value === "on")}
          options={(["on", "off"] as const).map((value) => ({
            value,
            icon: ENABLED_ICONS[value],
            title: t(`enabled.options.${value}.title`),
            description: t(`enabled.options.${value}.description`),
          }))}
        />
      </FormSection>

      <FormSection
        id="sandbox-defaults"
        icon={ShieldCheckIcon}
        title={t("defaults.title")}
        description={t("defaults.description")}
      >
        <SandboxPolicyEditor name="sandbox-defaults" value={defaults} onChange={setDefaults} />
      </FormSection>

      <FormSection id="sandbox-limits" icon={TimerIcon} title={t("limits.title")} description={t("limits.description")}>
        <Field orientation="responsive" data-invalid={timeoutSec === null || undefined}>
          <FieldContent>
            <FieldLabel htmlFor="sandbox-timeout">{t("limits.commandTimeout")}</FieldLabel>
            <FieldDescription>{t("limits.commandTimeoutHint", limits.commandTimeoutSec)}</FieldDescription>
          </FieldContent>
          <Input
            id="sandbox-timeout"
            type="number"
            inputMode="numeric"
            min={limits.commandTimeoutSec.min}
            max={limits.commandTimeoutSec.max}
            step={1}
            value={timeout}
            onChange={(e) => setTimeoutText(e.target.value)}
            aria-invalid={timeoutSec === null || undefined}
            className="tabular sm:w-28"
          />
        </Field>
      </FormSection>

      <FormSection id="sandbox-docker" icon={CpuIcon} title={t("docker.title")} description={t("docker.description")}>
        <FieldGroup>
          <Field orientation="responsive" data-invalid={memoryMb === null || undefined}>
            <FieldContent>
              <FieldLabel htmlFor="sandbox-memory">{t("docker.memory")}</FieldLabel>
              <FieldDescription>{t("docker.memoryHint", limits.memoryMb)}</FieldDescription>
            </FieldContent>
            <Input
              id="sandbox-memory"
              type="number"
              inputMode="numeric"
              min={limits.memoryMb.min}
              max={limits.memoryMb.max}
              step={256}
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
              aria-invalid={memoryMb === null || undefined}
              className="tabular sm:w-28"
            />
          </Field>
          <FieldSeparator />
          <Field orientation="responsive" data-invalid={cpuCount === null || undefined}>
            <FieldContent>
              <FieldLabel htmlFor="sandbox-cpus">{t("docker.cpus")}</FieldLabel>
              <FieldDescription>{t("docker.cpusHint", limits.cpus)}</FieldDescription>
            </FieldContent>
            <Input
              id="sandbox-cpus"
              type="number"
              inputMode="decimal"
              min={limits.cpus.min}
              max={limits.cpus.max}
              step={0.25}
              value={cpus}
              onChange={(e) => setCpus(e.target.value)}
              aria-invalid={cpuCount === null || undefined}
              className="tabular sm:w-28"
            />
          </Field>
        </FieldGroup>
        <FormSubsection
          title={t("docker.runtime")}
          description={status?.docker.available && !status.docker.gvisor ? t("docker.gvisorMissing") : undefined}
        >
          <OptionCards
            name="sandbox-runtime"
            label={t("docker.runtime")}
            value={runtime}
            onValueChange={setRuntime}
            className="lg:grid-cols-3"
            options={SANDBOX_RUNTIMES.map((value) => ({
              value,
              icon: RUNTIME_ICONS[value],
              title: t(`docker.runtimes.${value}.title`),
              description: t(`docker.runtimes.${value}.description`),
            }))}
          />
        </FormSubsection>
      </FormSection>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending || invalid}>
          {pending ? <Spinner /> : <SaveIcon />} {tc("save")}
        </Button>
      </div>
    </form>
  );
}

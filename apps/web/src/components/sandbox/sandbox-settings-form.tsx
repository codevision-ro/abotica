"use client";

import { SANDBOX_RUNTIMES, type SandboxRuntime } from "@abotica/core/sandbox-policy";
import { type AppSettings, SETTINGS_LIMITS } from "@abotica/core/settings";
import {
  BoxIcon,
  BoxesIcon,
  ContainerIcon,
  CpuIcon,
  PowerOffIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormSection, FormSectionCollapsible, FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { SettingsNumberField } from "@/components/settings/settings-number-field";
import { SettingsSaveBar } from "@/components/settings/settings-save-bar";
import { useSettingsForm } from "@/components/settings/use-settings-form";
import { FieldGroup, FieldSeparator } from "@/components/ui/field";
import type { SandboxStatusView } from "@/server/queries/sandbox";
import { SandboxPolicyEditor } from "./sandbox-policy-editor";

const ENABLED_ICONS: Record<"on" | "off", LucideIcon> = { on: ContainerIcon, off: PowerOffIcon };

const RUNTIME_ICONS: Record<SandboxRuntime, LucideIcon> = {
  auto: SparklesIcon,
  runc: BoxIcon,
  runsc: ShieldCheckIcon,
};

const ADVANCED = ["pids", "pauseIdleMinutes", "stopIdleHours", "workspaceRetentionDays"] as const;

const L = SETTINGS_LIMITS.sandbox;

/** Settings > Sandbox form: on or off, default policy, command timeout, container limits and idle times. */
export function SandboxSettingsForm({ initial, status }: { initial: AppSettings["sandbox"]; status: SandboxStatusView }) {
  const t = useTranslations("sandbox.settings");
  const form = useSettingsForm("sandbox", initial);
  const { values, set, error } = form;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // A problem in a closed section would leave the save bar refusing for no visible reason.
  const advancedInvalid = ADVANCED.some((field) => error(field));

  return (
    <div className="flex flex-col gap-6">
      <FormSection id="sandbox-enabled" icon={BoxesIcon} title={t("enabled.title")} description={t("enabled.description")}>
        <OptionCards
          name="sandbox-enabled"
          label={t("enabled.title")}
          value={values.enabled ? "on" : "off"}
          onValueChange={(value) => set({ enabled: value === "on" })}
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
        <SandboxPolicyEditor name="sandbox-defaults" value={values.defaults} onChange={(defaults) => set({ defaults })} />
      </FormSection>

      <FormSection id="sandbox-limits" icon={TimerIcon} title={t("limits.title")} description={t("limits.description")}>
        <FieldGroup>
          <SettingsNumberField
            id="sandbox-timeout"
            label={t("limits.commandTimeout")}
            hint={t("limits.commandTimeoutHint", L.commandTimeoutSec)}
            unit={t("units.seconds")}
            value={values.commandTimeoutSec}
            onChange={(commandTimeoutSec) => set({ commandTimeoutSec })}
            error={error("commandTimeoutSec")}
            {...L.commandTimeoutSec}
          />
        </FieldGroup>
      </FormSection>

      <FormSection id="sandbox-docker" icon={CpuIcon} title={t("docker.title")} description={t("docker.description")}>
        <FieldGroup>
          <SettingsNumberField
            id="sandbox-memory"
            label={t("docker.memory")}
            hint={t("docker.memoryHint", L.memoryMb)}
            unit="MB"
            step={256}
            value={values.memoryMb}
            onChange={(memoryMb) => set({ memoryMb })}
            error={error("memoryMb")}
            {...L.memoryMb}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="sandbox-cpus"
            label={t("docker.cpus")}
            hint={t("docker.cpusHint", L.cpus)}
            decimal
            step={0.25}
            value={values.cpus}
            onChange={(cpus) => set({ cpus })}
            error={error("cpus")}
            {...L.cpus}
          />
        </FieldGroup>
        <FormSubsection
          title={t("docker.runtime")}
          description={status?.docker.available && !status.docker.gvisor ? t("docker.gvisorMissing") : undefined}
        >
          <OptionCards
            name="sandbox-runtime"
            label={t("docker.runtime")}
            value={values.runtime}
            onValueChange={(runtime) => set({ runtime })}
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

      <FormSectionCollapsible
        id="sandbox-advanced"
        icon={SlidersHorizontalIcon}
        title={t("advanced.title")}
        summary={t("advanced.summary", {
          pids: values.pids,
          pause: values.pauseIdleMinutes,
          stop: values.stopIdleHours,
          days: values.workspaceRetentionDays,
        })}
        open={advancedOpen || advancedInvalid}
        onOpenChange={setAdvancedOpen}
      >
        <FieldGroup>
          <SettingsNumberField
            id="sandbox-pids"
            label={t("advanced.pids")}
            hint={t("advanced.pidsHint", L.pids)}
            value={values.pids}
            onChange={(pids) => set({ pids })}
            error={error("pids")}
            {...L.pids}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="sandbox-pause-idle"
            label={t("advanced.pauseIdle")}
            hint={t("advanced.pauseIdleHint", L.pauseIdleMinutes)}
            unit={t("units.minutes")}
            value={values.pauseIdleMinutes}
            onChange={(pauseIdleMinutes) => set({ pauseIdleMinutes })}
            error={error("pauseIdleMinutes")}
            {...L.pauseIdleMinutes}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="sandbox-stop-idle"
            label={t("advanced.stopIdle")}
            hint={t("advanced.stopIdleHint", L.stopIdleHours)}
            unit={t("units.hours")}
            value={values.stopIdleHours}
            onChange={(stopIdleHours) => set({ stopIdleHours })}
            error={error("stopIdleHours")}
            {...L.stopIdleHours}
          />
          <FieldSeparator />
          <SettingsNumberField
            id="sandbox-retention"
            label={t("advanced.retention")}
            hint={t("advanced.retentionHint", L.workspaceRetentionDays)}
            unit={t("units.days")}
            value={values.workspaceRetentionDays}
            onChange={(workspaceRetentionDays) => set({ workspaceRetentionDays })}
            error={error("workspaceRetentionDays")}
            {...L.workspaceRetentionDays}
          />
        </FieldGroup>
      </FormSectionCollapsible>

      <SettingsSaveBar
        dirty={form.dirty}
        invalid={form.invalid}
        pending={form.pending}
        onSave={form.save}
        onReset={form.reset}
      />
    </div>
  );
}

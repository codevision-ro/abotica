"use client";

import {
  isPackageSpec,
  NETWORK_MODES,
  type NetworkMode,
  type NetworkPolicy,
  normalizeDomain,
  SANDBOX_LIMITS,
  type SandboxPackages,
  type SandboxPolicy,
} from "@abotica/core/sandbox-policy";
import { GlobeIcon, GlobeLockIcon, PackageIcon, WifiOffIcon, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormSubsection } from "@/components/app/form-section";
import { OptionCards } from "@/components/app/option-cards";
import { TokenListEditor } from "./token-list-editor";

const MODE_ICONS: Record<NetworkMode, LucideIcon> = {
  off: WifiOffIcon,
  packages: PackageIcon,
  custom: GlobeLockIcon,
  full: GlobeIcon,
};

/** "Package registries · 3 packages": a policy in one line, for summaries and option descriptions. */
export function usePolicySummary() {
  const t = useTranslations("sandbox");
  return {
    network: (network: NetworkPolicy) =>
      network.mode === "custom"
        ? t("network.customSummary", { count: network.domains.length })
        : t(`network.modes.${network.mode}.title`),
    policy: (policy: SandboxPolicy) =>
      `${t(`network.modes.${policy.network.mode}.title`)} · ${t("packages.count", {
        count: policy.packages.python.length + policy.packages.node.length,
      })}`,
  };
}

/** Network mode as option cards, and the allowed domains when the mode takes a list. */
export function NetworkPolicyEditor({
  name,
  value,
  onChange,
}: {
  /** Radio group name, unique on the page. */
  name: string;
  value: NetworkPolicy;
  onChange: (value: NetworkPolicy) => void;
}) {
  const t = useTranslations("sandbox");
  return (
    <div className="flex flex-col gap-4">
      <OptionCards
        name={name}
        label={t("network.label")}
        value={value.mode}
        // Domains are kept while another mode is picked, so switching back restores them.
        onValueChange={(mode) => onChange({ ...value, mode })}
        options={NETWORK_MODES.map((mode) => ({
          value: mode,
          icon: MODE_ICONS[mode],
          title: t(`network.modes.${mode}.title`),
          description: t(`network.modes.${mode}.description`),
        }))}
      />
      {value.mode === "custom" && (
        <FormSubsection title={t("network.domains")} count={value.domains.length} description={t("network.domainsHint")}>
          <TokenListEditor
            label={t("network.domains")}
            values={value.domains}
            onChange={(domains) => onChange({ ...value, domains })}
            parse={(raw) => {
              const domain = normalizeDomain(raw);
              return domain ? { value: domain } : { error: t("errors.invalidDomain", { domain: raw }) };
            }}
            max={SANDBOX_LIMITS.domains}
            tooMany={t("errors.tooManyDomains", { max: SANDBOX_LIMITS.domains })}
            placeholder={t("network.domainPlaceholder")}
            addLabel={t("add")}
            removeLabel={(domain) => t("remove", { value: domain })}
          />
        </FormSubsection>
      )}
    </div>
  );
}

/** Pip or npm specifiers installed before the first command. */
function PackageListEditor({
  kind,
  value,
  onChange,
}: {
  kind: keyof SandboxPackages;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const t = useTranslations("sandbox");
  return (
    <FormSubsection title={t(`packages.${kind}`)} count={value.length} description={t(`packages.${kind}Hint`)}>
      <TokenListEditor
        label={t(`packages.${kind}`)}
        values={value}
        onChange={onChange}
        parse={(raw) => (isPackageSpec(kind, raw) ? { value: raw } : { error: t("errors.invalidPackage", { name: raw }) })}
        max={SANDBOX_LIMITS.packages}
        tooMany={t("errors.tooManyPackages", { max: SANDBOX_LIMITS.packages })}
        placeholder={t(`packages.${kind}Placeholder`)}
        addLabel={t("add")}
        removeLabel={(name) => t("remove", { value: name })}
      />
    </FormSubsection>
  );
}

/** Network access and packages of a workspace: the sandbox defaults in Settings > System. */
export function SandboxPolicyEditor({
  name,
  value,
  onChange,
}: {
  /** Prefix for the radio group names, unique on the page. */
  name: string;
  value: SandboxPolicy;
  onChange: (value: SandboxPolicy) => void;
}) {
  const t = useTranslations("sandbox");
  const setPackages = (kind: keyof SandboxPackages, list: string[]) =>
    onChange({ ...value, packages: { ...value.packages, [kind]: list } });
  return (
    <>
      <FormSubsection title={t("network.label")} description={t("network.description")}>
        <NetworkPolicyEditor
          name={`${name}-network`}
          value={value.network}
          onChange={(network) => onChange({ ...value, network })}
        />
      </FormSubsection>
      <PackageListEditor kind="python" value={value.packages.python} onChange={(list) => setPackages("python", list)} />
      <PackageListEditor kind="node" value={value.packages.node} onChange={(list) => setPackages("node", list)} />
    </>
  );
}

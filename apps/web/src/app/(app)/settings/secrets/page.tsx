import { PROVIDER_IDS, PROVIDER_KEY_SECRET, PROVIDERS, TELEGRAM_TOKEN_SECRET } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type SecretUse, VaultManager } from "@/components/settings/vault-manager";
import { listProjectOptions, listVaultSecrets, type VaultSecretRow } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.secrets");
  return { title: t("title") };
}

export default async function SecretsPage() {
  const [secrets, projects, t] = await Promise.all([
    listVaultSecrets(),
    listProjectOptions(),
    getTranslations("settings.secrets"),
  ]);

  /** Where a secret is used, linking to the page that sets it up; null for a global one used by name. */
  const usageOf = (secret: VaultSecretRow): SecretUse | null => {
    if (secret.projectId) {
      const project = secret.projectName ?? "";
      return { label: project, href: `/projects/${secret.projectId}?tab=secrets`, title: t("use.project", { project }) };
    }
    // Provider keys and the bot token count only as global secrets (see getSecret).
    const provider = PROVIDER_IDS.find((id) => PROVIDER_KEY_SECRET[id] === secret.name);
    if (provider) {
      const label = PROVIDERS[provider].label;
      return { label, href: "/settings/models", title: t("use.provider", { provider: label }) };
    }
    if (secret.name === TELEGRAM_TOKEN_SECRET) {
      return { label: t("use.telegramLabel"), href: "/settings/telegram", title: t("use.telegram") };
    }
    return null;
  };

  return (
    <VaultManager
      title={t("title")}
      description={t("description")}
      secrets={secrets.map((secret) => ({ ...secret, use: usageOf(secret) }))}
      projects={projects}
    />
  );
}

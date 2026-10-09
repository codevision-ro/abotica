import { PROVIDER_IDS, PROVIDER_KEY_SECRET, PROVIDERS, TELEGRAM_TOKEN_SECRET } from "@abotica/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type KeysFilter, type KeyUse, KeysManager } from "@/components/settings/keys-manager";
import { listProjectOptions } from "@/server/queries/projects";
import { listVaultSecrets, type VaultSecretRow } from "@/server/queries/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { title: t("keys") };
}

/** Settings > Keys: every key in the vault, or one project's (`?project=<id>`) or the global ones (`?project=global`). */
export default async function KeysPage(props: PageProps<"/settings/keys">) {
  const { project } = await props.searchParams;
  const [secrets, projects, t] = await Promise.all([
    listVaultSecrets(),
    listProjectOptions(),
    getTranslations("settings.keys"),
  ]);
  // An unknown project (deleted, mistyped) shows every key rather than an empty list.
  const filter: KeysFilter =
    project === "global"
      ? "global"
      : typeof project === "string" && projects.some((p) => p.id === project)
        ? { projectId: project }
        : "all";
  const shown = secrets.filter((secret) =>
    filter === "all" ? true : filter === "global" ? secret.projectId === null : secret.projectId === filter.projectId,
  );

  /** Where a key is used, linking to the page that sets it up; null for a global one used by name. */
  const usageOf = (secret: VaultSecretRow): KeyUse | null => {
    if (secret.projectId) {
      const name = secret.projectName ?? "";
      return { label: name, href: `/projects/${secret.projectId}`, title: t("use.project", { project: name }) };
    }
    // Provider keys and the bot token count only as global keys (see getSecret).
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
    <KeysManager
      title={t("title")}
      description={t("description")}
      secrets={shown.map((secret) => ({ ...secret, use: usageOf(secret) }))}
      names={secrets.map((secret) => secret.name)}
      projects={projects}
      filter={filter}
    />
  );
}

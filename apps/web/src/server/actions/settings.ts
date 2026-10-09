"use server";

import {
  audit,
  changeEmbeddingProvider,
  cheapestToolModel,
  connectSubscription,
  disconnectSubscription,
  EMBEDDING_PROVIDERS,
  getCatalog,
  isProviderConfigured,
  isProviderId,
  languageModel,
  MODEL_ROLES,
  parseHttpUrl,
  PROVIDER_IDS,
  PROVIDER_KEY_SECRET,
  refreshCatalog,
  removeProviderKey,
  saveProviderKey,
  SETTINGS_SCHEMAS,
  SignInCallbackError,
  startSubscriptionSignIn,
  SUBSCRIPTION_PROVIDER_IDS,
  updateSettings,
} from "@abotica/core";
import { UserError } from "@abotica/i18n";
import { generateText } from "ai";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";
import { requestOrigin } from "../request-origin";

/** Provider connections change which models agents and their forms can pick. */
function revalidateProviders() {
  revalidatePath("/settings/models");
  revalidatePath("/agents", "layout");
}

const providerId = z.enum(PROVIDER_IDS as [string, ...string[]]).transform((v) => v as (typeof PROVIDER_IDS)[number]);

/** Saves an API key; a provider connected through its plan switches to the key. */
export const setProviderKey = action(
  z.object({ provider: providerId, value: z.string().trim().min(8, "settings.validation.keyTooShort") }),
  async ({ provider, value }) => {
    const t = await getTranslations("settings.providers");
    await saveProviderKey(provider, value, t("secretDescription", { provider }));
    await audit({
      actor: "user",
      action: "provider.key-set",
      entityType: "secret",
      entityId: PROVIDER_KEY_SECRET[provider],
      data: { provider },
    });
    revalidateProviders();
  },
);

export const deleteProviderKey = action(z.object({ provider: providerId }), async ({ provider }) => {
  await removeProviderKey(provider);
  await audit({
    actor: "user",
    action: "provider.key-removed",
    entityType: "secret",
    entityId: PROVIDER_KEY_SECRET[provider],
    data: { provider },
  });
  revalidateProviders();
});

/** Ollama has no key: turning it on is what connects it. The change is audited by updateSettings. */
export const setOllamaEnabled = action(z.object({ enabled: z.boolean() }), async ({ enabled }) => {
  await updateSettings("models", { ollama: { enabled } });
  revalidateProviders();
});

/** Saves where the Ollama server listens, as this machine sees it, then lists its models from there. */
export const setOllamaBaseUrl = action(
  z.object({ url: z.string().refine((v) => parseHttpUrl(v) !== null, "settings.validation.models.ollamaUrl") }),
  async ({ url }) => {
    await updateSettings("models", { ollama: { baseUrl: url } });
    // models.dev being unreachable must not fail the save: the Ollama models are what changed.
    const models = await refreshCatalog().catch((error: unknown) => {
      console.warn("[catalog] refresh after the Ollama address changed failed:", error);
      return [];
    });
    revalidateProviders();
    return { models: models.filter((m) => m.provider === "ollama").length };
  },
);

/**
 * Switches what embeds memory, journals and knowledge; the stored embeddings are cleared and made again
 * in the background (see changeEmbeddingProvider).
 */
export const setEmbeddingProvider = action(z.object({ provider: z.enum(EMBEDDING_PROVIDERS) }), async ({ provider }) => {
  const reindex = await changeEmbeddingProvider(provider);
  revalidatePath("/settings/agents");
  return { total: reindex?.total ?? 0 };
});

const subscriptionId = z
  .enum(SUBSCRIPTION_PROVIDER_IDS as [string, ...string[]])
  .transform((v) => v as (typeof SUBSCRIPTION_PROVIDER_IDS)[number]);

/** Starts signing in to a subscription; `direct` when the browser comes back by itself, else the user pastes the address. */
export const startSubscription = action(z.object({ provider: subscriptionId }), async ({ provider }) =>
  startSubscriptionSignIn(provider, await requestOrigin()),
);

const SIGN_IN_ERRORS = {
  expired: "settings.errors.subscriptionExpired",
  denied: "settings.errors.subscriptionDenied",
  "not-granted": "settings.errors.subscriptionNotGranted",
  failed: "settings.errors.subscriptionFailed",
} as const;

/** Completes a sign-in from the callback address the user pasted (the app was not opened over loopback). */
export const completeSubscription = action(
  z.object({ provider: subscriptionId, callbackUrl: z.string().trim().min(1) }),
  async ({ provider, callbackUrl }) => {
    let params: URLSearchParams;
    try {
      params = new URL(callbackUrl).searchParams;
    } catch {
      throw new UserError("settings.errors.subscriptionAddress");
    }
    if (!params.has("state")) throw new UserError("settings.errors.subscriptionAddress");
    try {
      await connectSubscription(params, provider);
    } catch (error) {
      if (!(error instanceof SignInCallbackError)) throw error;
      throw new UserError(SIGN_IN_ERRORS[error.reason], { error: error.message });
    }
    revalidateProviders();
  },
);

export const disconnectSubscriptionAccount = action(z.object({ provider: subscriptionId }), async ({ provider }) => {
  const result = await disconnectSubscription(provider);
  revalidateProviders();
  return result;
});

export const testProvider = action(z.object({ provider: providerId }), async ({ provider }) => {
  const model = cheapestToolModel(await getCatalog(), provider);
  if (!model) throw new UserError(provider === "ollama" ? "settings.errors.noOllamaModel" : "settings.errors.noModel");
  const started = Date.now();
  try {
    const result = await generateText({
      model: await languageModel(provider, model.id),
      prompt: "Reply with OK only",
      maxOutputTokens: 5,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(20_000),
    });
    return { model: model.id, latencyMs: Date.now() - started, text: result.text.trim() };
  } catch (error) {
    const e = error as Error;
    if (e.name === "TimeoutError" || e.name === "AbortError")
      throw new UserError("settings.errors.testTimeout", { model: model.id });
    throw new Error(`${model.id}: ${e.message}`);
  }
});

export const refreshModelCatalog = action(z.object({}), async () => {
  const models = await refreshCatalog();
  const counts: Record<string, number> = {};
  for (const m of models) counts[m.provider] = (counts[m.provider] ?? 0) + 1;
  await audit({ actor: "user", action: "catalog.refreshed", entityType: "system", data: { total: models.length } });
  revalidateProviders();
  return { total: models.length, counts };
});

const modelsSchema = SETTINGS_SCHEMAS.models.shape;

/**
 * The default models and efforts per role, one save for all. Every model must be on a connected provider;
 * the specialists' chain is required, while the super agent's and the managers' may stay empty to follow
 * it (and their efforts null to follow its effort). Returns the models settings as stored.
 */
export const updateDefaultModels = action(
  z.object({
    chains: modelsSchema.chains.refine((chains) => chains.agent.length > 0, "settings.validation.models.atLeastOneModel"),
    reasoningEffort: modelsSchema.reasoningEffort,
  }),
  async ({ chains, reasoningEffort }) => {
    for (const role of MODEL_ROLES) {
      for (const m of chains[role]) {
        if (!isProviderId(m.provider) || !(await isProviderConfigured(m.provider))) {
          throw new UserError("settings.errors.providerNoKey", { provider: m.provider });
        }
      }
    }
    const next = await updateSettings("models", { chains, reasoningEffort });
    revalidateProviders();
    return next;
  },
);

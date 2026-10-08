"use server";

import {
  announceTelegramChange,
  type AppSettings,
  audit,
  changeEmbeddingProvider,
  cheapestToolModel,
  connectSubscription,
  disconnectSubscription,
  fetchTelegramBot,
  getCatalog,
  getSettings,
  isProviderConfigured,
  isTelegramChatId,
  languageModel,
  parseHttpUrl,
  publish,
  removeProviderKey,
  removeTelegramToken,
  saveProviderKey,
  saveTelegramAccess,
  saveTelegramToken,
  PROVIDER_IDS,
  PROVIDER_KEY_SECRET,
  refreshCatalog,
  RUN_CONCURRENCY_MAX,
  SignInCallbackError,
  startSubscriptionSignIn,
  SUBSCRIPTION_PROVIDER_IDS,
  updateSettings,
  syncSettingsSchedules,
  TELEGRAM_TOKEN_SECRET,
  upsertSecret,
} from "@abotica/core";
import { REASONING_EFFORTS } from "@abotica/core/models/reasoning";
import { db, secrets } from "@abotica/db";
import { locales, UserError } from "@abotica/i18n";
import { eq } from "@abotica/db/orm";
import { generateText } from "ai";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { isTimeZone } from "@/lib/time-zone";
import { action } from "../action";
import { requestOrigin } from "../request-origin";

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
    revalidatePath("/settings");
    revalidatePath("/agents", "layout");
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
  revalidatePath("/settings");
  revalidatePath("/agents", "layout");
});

export const setOllamaEnabled = action(z.object({ enabled: z.boolean() }), async ({ enabled }) => {
  await updateSettings({ ollamaEnabled: enabled });
  await audit({
    actor: "user",
    action: enabled ? "provider.enabled" : "provider.disabled",
    entityType: "settings",
    entityId: "app",
    data: { provider: "ollama" },
  });
  revalidatePath("/settings");
  revalidatePath("/agents", "layout");
});

/** Saves where the Ollama server listens, as this machine sees it, then lists its models from there. */
export const setOllamaBaseUrl = action(
  z.object({ url: z.string().refine((v) => parseHttpUrl(v) !== null, "settings.validation.ollamaUrl") }),
  async ({ url }) => {
    const before = await getSettings();
    const ollamaBaseUrl = parseHttpUrl(url)!;
    await updateSettings({ ollamaBaseUrl });
    if (before.ollamaBaseUrl !== ollamaBaseUrl) {
      await audit({
        actor: "user",
        action: "settings.updated",
        entityType: "settings",
        entityId: "app",
        data: { ollamaBaseUrl: { from: before.ollamaBaseUrl, to: ollamaBaseUrl } },
      });
    }
    // models.dev being unreachable must not fail the save: the Ollama models are what changed.
    const models = await refreshCatalog().catch((error: unknown) => {
      console.warn("[catalog] refresh after the Ollama address changed failed:", error);
      return [];
    });
    revalidatePath("/settings");
    revalidatePath("/agents", "layout");
    return { models: models.filter((m) => m.provider === "ollama").length };
  },
);

/**
 * Switches what embeds memory, journals and knowledge; the stored embeddings are cleared and made again
 * in the background (see changeEmbeddingProvider).
 */
export const setEmbeddingProvider = action(z.object({ provider: z.enum(["openai", "ollama"]) }), async ({ provider }) => {
  const before = await getSettings();
  const reindex = await changeEmbeddingProvider(provider);
  if (reindex) {
    await audit({
      actor: "user",
      action: "settings.updated",
      entityType: "settings",
      entityId: "app",
      data: { embeddingProvider: { from: before.embeddingProvider, to: provider }, reembedding: reindex.total },
    });
  }
  revalidatePath("/settings");
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
    revalidatePath("/settings");
    revalidatePath("/agents", "layout");
  },
);

export const disconnectSubscriptionAccount = action(z.object({ provider: subscriptionId }), async ({ provider }) => {
  const result = await disconnectSubscription(provider);
  revalidatePath("/settings");
  revalidatePath("/agents", "layout");
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
  revalidatePath("/settings");
  return { total: models.length, counts };
});

export const updateAppSettings = action(
  z.object({
    journalDays: z
      .number()
      .int()
      .min(1, "settings.validation.journalDaysMin")
      .max(30, "settings.validation.journalDaysMax"),
    memoryRequiresApproval: z.boolean(),
    memoryPinnedTokens: z
      .number()
      .int()
      .min(0, "settings.validation.memoryPinnedTokensRange")
      .max(20_000, "settings.validation.memoryPinnedTokensRange"),
    memoryRecallTokens: z
      .number()
      .int()
      .min(0, "settings.validation.memoryRecallTokensRange")
      .max(8_000, "settings.validation.memoryRecallTokensRange"),
    parallelDelegations: z
      .number()
      .int()
      .min(1, "settings.validation.parallelDelegationsRange")
      .max(10, "settings.validation.parallelDelegationsRange"),
    runConcurrency: z
      .number()
      .int()
      .min(1, "settings.validation.runConcurrencyRange")
      .max(RUN_CONCURRENCY_MAX, "settings.validation.runConcurrencyRange"),
    digestHour: z.number().int().min(0, "settings.validation.digestHour").max(23, "settings.validation.digestHour"),
    timezone: z.string().trim().min(1).refine(isTimeZone, "settings.validation.timezone"),
    monthlyBudgetUsd: z.number().positive("settings.validation.budgetPositive").nullable(),
  }),
  async (input) => {
    const before = await getSettings();
    const next = await updateSettings(input);
    const changed = Object.fromEntries(
      (Object.keys(input) as (keyof AppSettings)[])
        .filter((k) => before[k] !== next[k])
        .map((k) => [k, { from: before[k], to: next[k] }]),
    );
    if (Object.keys(changed).length) {
      await audit({ actor: "user", action: "settings.updated", entityType: "settings", entityId: "app", data: changed });
    }
    if (changed.digestHour || changed.timezone) await syncSettingsSchedules(next);
    // The worker applies a new run concurrency at once, without a restart.
    if (changed.runConcurrency) await publish({ type: "settings.updated" });
    revalidatePath("/settings/general");
    return next;
  },
);

export const setVaultSecret = action(
  z.object({
    name: z
      .string()
      .trim()
      .min(1, "settings.validation.nameRequired")
      .max(64)
      .regex(/^[A-Z0-9_]+$/, "settings.validation.nameFormat"),
    value: z.string().min(1, "settings.validation.valueRequired"),
    description: z.string().trim().max(300).default(""),
    projectId: z.uuid().nullable().default(null),
  }),
  async ({ name, value, description, projectId }) => {
    // The vault page shows every secret with its owner, so it is the one place a secret may change owner.
    await upsertSecret({ name, value, description, projectId }, { allowMove: true });
    if (name === TELEGRAM_TOKEN_SECRET) await announceTelegramChange();
    revalidatePath("/settings/vault");
    revalidatePath("/settings");
    return null;
  },
);

export const deleteVaultSecret = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const [row] = await db.delete(secrets).where(eq(secrets.id, id)).returning({ name: secrets.name });
  if (row) await audit({ actor: "user", action: "secret.deleted", entityType: "secret", entityId: row.name });
  if (row?.name === TELEGRAM_TOKEN_SECRET) await announceTelegramChange();
  revalidatePath("/settings/vault");
  revalidatePath("/settings");
  return null;
});

const modelChain = z
  .array(z.object({ provider: providerId, model: z.string().trim().min(1, "settings.validation.pickModelEachRow") }))
  .max(10);

/**
 * The agents' default chain is required; the super agent's and the managers' may stay empty to follow
 * it, and their efforts null to follow the agents' effort.
 */
export const updateDefaultModels = action(
  z.object({
    defaultModels: modelChain.min(1, "settings.validation.atLeastOneModel"),
    orchestratorModels: modelChain,
    managerModels: modelChain,
    defaultReasoningEffort: z.enum(REASONING_EFFORTS),
    orchestratorReasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
    managerReasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  }),
  async (input) => {
    for (const m of [...input.defaultModels, ...input.orchestratorModels, ...input.managerModels]) {
      if (!(await isProviderConfigured(m.provider))) {
        throw new UserError("settings.errors.providerNoKey", { provider: m.provider });
      }
    }
    const before = await getSettings();
    await updateSettings(input);
    await audit({
      actor: "user",
      action: "settings.default-models-changed",
      entityType: "settings",
      entityId: "app",
      data: {
        from: before.defaultModels,
        to: input.defaultModels,
        orchestratorModels: { from: before.orchestratorModels, to: input.orchestratorModels },
        managerModels: { from: before.managerModels, to: input.managerModels },
        reasoningEffort: { from: before.defaultReasoningEffort, to: input.defaultReasoningEffort },
        orchestratorReasoningEffort: { from: before.orchestratorReasoningEffort, to: input.orchestratorReasoningEffort },
        managerReasoningEffort: { from: before.managerReasoningEffort, to: input.managerReasoningEffort },
      },
    });
    revalidatePath("/settings");
    revalidatePath("/agents", "layout");
  },
);

export const updateLanguage = action(z.object({ locale: z.enum(locales).nullable() }), async ({ locale }) => {
  const before = await getSettings();
  await updateSettings({ locale });
  if (before.locale !== locale) {
    await audit({
      actor: "user",
      action: "settings.updated",
      entityType: "settings",
      entityId: "app",
      data: { locale: { from: before.locale, to: locale } },
    });
  }
  revalidatePath("/", "layout");
});

/**
 * Settings > Telegram, saved as one form. A new token is checked with Telegram first, so a wrong one is
 * refused here instead of failing in the worker; an empty one keeps the stored token.
 */
export const updateTelegramSettings = action(
  z.object({
    token: z.string().trim().default(""),
    allowedUserIds: z.array(z.number().int().positive("settings.telegram.validation.userIds")).max(50),
    notifyChatId: z.string().trim().refine(isTelegramChatId, "settings.telegram.validation.chatId").nullable(),
  }),
  async ({ token, allowedUserIds, notifyChatId }) => {
    const bot = token ? await fetchTelegramBot(token) : null;
    if (token) {
      const t = await getTranslations("settings.telegram");
      await saveTelegramToken(token, t("secretDescription"));
    }
    await saveTelegramAccess({ allowedUserIds, notifyChatId });
    revalidatePath("/settings/telegram");
    revalidatePath("/");
    return { username: bot?.username ?? null };
  },
);

export const deleteTelegramToken = action(z.object({}), async () => {
  await removeTelegramToken();
  revalidatePath("/settings/telegram");
  revalidatePath("/");
});

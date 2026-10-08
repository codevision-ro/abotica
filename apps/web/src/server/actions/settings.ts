"use server";

import {
  type AppSettings,
  audit,
  cheapestToolModel,
  connectSubscription,
  disconnectSubscription,
  getCatalog,
  getSettings,
  isProviderConfigured,
  languageModel,
  removeProviderKey,
  saveProviderKey,
  PROVIDER_IDS,
  PROVIDER_KEY_SECRET,
  refreshCatalog,
  SignInCallbackError,
  startSubscriptionSignIn,
  SUBSCRIPTION_PROVIDER_IDS,
  updateSettings,
  syncSettingsSchedules,
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
    revalidatePath("/settings/vault");
    revalidatePath("/settings");
    return null;
  },
);

export const deleteVaultSecret = action(z.object({ id: z.uuid() }), async ({ id }) => {
  const [row] = await db.delete(secrets).where(eq(secrets.id, id)).returning({ name: secrets.name });
  if (row) await audit({ actor: "user", action: "secret.deleted", entityType: "secret", entityId: row.name });
  revalidatePath("/settings/vault");
  revalidatePath("/settings");
  return null;
});

export const updateDefaultModels = action(
  z.object({
    defaultModels: z
      .array(z.object({ provider: providerId, model: z.string().trim().min(1, "settings.validation.pickModelEachRow") }))
      .min(1, "settings.validation.atLeastOneModel")
      .max(10),
    defaultReasoningEffort: z.enum(REASONING_EFFORTS),
  }),
  async ({ defaultModels, defaultReasoningEffort }) => {
    for (const m of defaultModels) {
      if (!(await isProviderConfigured(m.provider))) {
        throw new UserError("settings.errors.providerNoKey", { provider: m.provider });
      }
    }
    const before = await getSettings();
    await updateSettings({ defaultModels, defaultReasoningEffort });
    await audit({
      actor: "user",
      action: "settings.default-models-changed",
      entityType: "settings",
      entityId: "app",
      data: {
        from: before.defaultModels,
        to: defaultModels,
        reasoningEffort: { from: before.defaultReasoningEffort, to: defaultReasoningEffort },
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

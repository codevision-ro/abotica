"use server";

import {
  availableProviders,
  createConversation,
  deleteConversation as deleteConversationRow,
  getOrchestrator,
  getSettings,
  isProviderId,
  modelRole,
  resolveModelChain,
  startProjectConversation,
} from "@abotica/core";
import { REASONING_EFFORTS } from "@abotica/core/models/reasoning";
import { agents, conversations, db } from "@abotica/db";
import { eq, sql } from "@abotica/db/orm";
import { UserError } from "@abotica/i18n";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { action } from "../action";
import { parseConversationFilter } from "@/lib/conversation-filter";
import { getConversationList, getConversationMessages } from "../queries/chat";

/**
 * Creates a web conversation for the caller to open. In a project core picks the manager when no agent
 * is given and checks that the agent is on the team; without a project it is with the given agent or
 * else the super agent.
 */
export const startConversation = action(
  z.object({ agentId: z.uuid().optional(), projectId: z.uuid().optional() }),
  async ({ agentId, projectId }) => {
    const t = await getTranslations("chat");
    const title = t("newConversationTitle");
    const conversation = projectId
      ? await startProjectConversation({ projectId, agentId, channel: "web", title })
      : await createConversation({ agentId: agentId ?? (await getOrchestrator()).id, channel: "web", title });
    revalidatePath("/chat", "layout");
    return { id: conversation.id };
  },
);

/** Core also removes the files the agents shared there and the conversation's sandbox workspace. */
export const deleteConversation = action(z.object({ id: z.string().uuid() }), async ({ id }) => {
  await deleteConversationRow(id);
  revalidatePath("/chat", "layout");
});

/** Fresh messages for an open chat, when a run starts there without the chat sending a message. */
export const loadConversationMessages = action(z.object({ id: z.string().uuid() }), async ({ id }) =>
  getConversationMessages(id),
);

/** The chat list grown past its first page ("Show more"): its newest `limit` conversations under `filter`. */
export const loadConversationList = action(
  z.object({ filter: z.string(), limit: z.number().int().positive() }),
  async ({ filter, limit }) => getConversationList(parseConversationFilter(filter), limit),
);

/**
 * Model and reasoning effort for one conversation only; the agent's config is untouched.
 * Null means the conversation follows the agent; for the model, so does exactly the agent's own.
 */
export const setConversationModel = action(
  z.object({
    conversationId: z.uuid(),
    model: z
      .object({
        provider: z.string().refine(isProviderId, "chat.model.errors.unknownProvider"),
        model: z.string().trim().min(1, "chat.model.errors.pickModel").max(200),
      })
      .nullable(),
    reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  }),
  async ({ conversationId, model, reasoningEffort }) => {
    const [row] = await db
      .select({
        id: agents.id,
        kind: agents.kind,
        provider: agents.provider,
        model: agents.model,
        fallbacks: agents.fallbacks,
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(eq(conversations.id, conversationId));
    if (!row) throw new UserError("chat.errors.conversationNotFound");

    if (model && !(await availableProviders()).some((p) => p.id === model.provider)) {
      throw new UserError("chat.model.errors.providerNotConfigured", { provider: model.provider });
    }

    const primary = resolveModelChain(row, (await getSettings()).models, modelRole(row))[0];
    const sameAsAgent = model && primary?.provider === model.provider && primary.model === model.model;
    const modelOverride = model && !sameAsAgent ? { provider: model.provider, model: model.model } : null;

    // Keep updatedAt: picking a model is not activity, so the conversation keeps its place in the list.
    await db
      .update(conversations)
      .set({ modelOverride, reasoningEffort, updatedAt: sql`${conversations.updatedAt}` })
      .where(eq(conversations.id, conversationId));
    revalidatePath(`/chat/${conversationId}`);
    return { model: modelOverride, reasoningEffort };
  },
);

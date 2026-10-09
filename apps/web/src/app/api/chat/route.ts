import {
  appendUserMessage,
  claimMessageFiles,
  ConversationBusyError,
  setTitleFromFirstMessage,
  startRun,
} from "@abotica/core";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import type { UIMessage } from "ai";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { getConversationWithAgent } from "@/server/queries/chat";
import { runStreamResponse } from "@/server/run-stream";
import { unauthorized } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * What the chat composer sends: a user message with text and uploaded files. Anything else (another
 * role, tool or reasoning parts, provider metadata) would be stored as history the agent trusts.
 */
const requestBody = z.object({
  conversationId: z.string().refine((value) => isUuid(value)),
  message: z.object({
    id: z.string().regex(/^[\w-]{1,100}$/),
    role: z.literal("user"),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({ type: z.literal("file"), url: z.string(), mediaType: z.string(), filename: z.string().optional() }),
        ]),
      )
      .min(1),
  }),
});

/** Adds the user's message, starts a run in the worker and relays its stream. */
export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const t = await getTranslations("chat");
  const parsed = requestBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(t("errors.invalidRequest"), { status: 400 });
  const { conversationId } = parsed.data;
  const message: UIMessage = parsed.data.message;
  const found = await getConversationWithAgent(conversationId);
  if (!found) return new Response(t("errors.conversationNotFound"), { status: 404 });

  // File parts must point at uploads (POST /api/files); they become the conversation's files.
  let userMessage: UIMessage;
  try {
    userMessage = await claimMessageFiles(message, conversationId);
  } catch (error) {
    if (!isUserError(error)) throw error;
    return new Response(translateKey(getTranslator(await getLocale()), error.key, error.values), { status: 400 });
  }
  await appendUserMessage(conversationId, userMessage);
  await setTitleFromFirstMessage(conversationId, userMessage, t("newConversationTitle"));

  try {
    const run = await startRun({ agentId: found.conversation.agentId, trigger: "chat", conversationId });
    return runStreamResponse(run.id, request.signal);
  } catch (error) {
    // The message is saved; the worker answers it when the current run ends.
    if (error instanceof ConversationBusyError) {
      const message = translateKey(getTranslator(await getLocale()), error.key, error.values);
      return new Response(message, { status: 409 });
    }
    throw error;
  }
}

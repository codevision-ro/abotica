"use server";

import { answerQuestion as answerTaskQuestion } from "@abotica/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { action } from "../action";

/**
 * The user answers a question (from the inbox or the task's timeline): the asker gets it at once, mid-run
 * or woken in its conversation.
 */
export const answerQuestion = action(
  z.object({
    questionId: z.uuid(),
    taskId: z.uuid(),
    text: z.string().trim().min(1, "inbox.validation.answerEmpty").max(20_000),
  }),
  async ({ questionId, taskId, text }) => {
    const posted = await answerTaskQuestion(questionId, text, "user");
    revalidatePath("/inbox");
    revalidatePath(`/tasks/${taskId}`);
    return { delivered: posted.delivered };
  },
);

import type { ModelMessage, StepResult, ToolSet, UIMessage } from "ai";
import type { StoredMessage } from "../runs/run-messages";
import type { StepPreparer } from "./step-preparation";

/**
 * Steering: messages the user (or a delegation report) sends while a run works reach it between two
 * steps instead of waiting for a follow-up run (Open SWE's message queue, Codex's pending input,
 * OpenClaw's queue steering). Before every step after the first, the run loads the conversation's user
 * messages that arrived since it started and that no run took in yet, appends them after the last tool
 * results and marks them taken in. That point is safe: streamText runs a step's tool calls to their
 * results before the next step starts, so no call is left without its result and no running tool is
 * interrupted. A run about to wait for approvals takes nothing in; those messages go to the follow-up.
 *
 * The answer is saved split around the messages it took in, so the conversation replays in the order
 * the model saw it: the answer before them, the messages, the answer after them.
 *
 * Telegram's send gate is the fallback for a message that arrives during the run's last step: the
 * answer it gets is held back (see holdStaleReply) and marked undelivered, which the next run is told.
 */

/** Messages a run took in before one of its steps. */
export type Steer = { step: number; messages: StoredMessage[] };

export type SteeringOptions = {
  /** The conversation's user messages that arrived since the run started and no run took in yet. */
  load: () => Promise<StoredMessage[]>;
  /** Records that the run took these messages in, after its step `afterStep`. */
  mark: (ids: string[], afterStep: number) => Promise<void>;
  /** The messages as model input, through the same pipeline as the run's history. */
  toModel: (messages: StoredMessage[]) => Promise<ModelMessage[]>;
  /** Ids of the messages already in the run's prompt. */
  inPrompt: Iterable<string>;
  /** After the messages went into the prompt; a failure here does not undo that. */
  onSteered?: (steer: Steer) => Promise<void>;
  /** Loading, converting or marking failed: the messages stay for the follow-up. */
  onError?: (error: unknown) => void;
};

/** The step asked for approvals: the run stops after it and waits. */
const awaitsApproval = (step: Pick<StepResult<ToolSet>, "content"> | undefined) =>
  step?.content.some((part) => part.type === "tool-approval-request" && !part.isAutomatic) ?? false;

/** The step preparer that takes new messages in, and what it took in so far (for saving the answer). */
export function createSteering(opts: SteeringOptions): { preparer: StepPreparer; steers: Steer[] } {
  const seen = new Set(opts.inPrompt);
  const steers: Steer[] = [];
  const preparer: StepPreparer = async ({ stepNumber, steps, messages }) => {
    if (stepNumber === 0 || awaitsApproval(steps.at(-1))) return null;
    let steer: Steer;
    let added: ModelMessage[];
    try {
      const arrived = (await opts.load()).filter((m) => !seen.has(m.message.id));
      if (!arrived.length) return null;
      // Converted before they are marked: a message marked but never shown would get no answer at all.
      added = await opts.toModel(arrived);
      await opts.mark(
        arrived.map((m) => m.message.id),
        stepNumber - 1,
      );
      for (const m of arrived) seen.add(m.message.id);
      steer = { step: stepNumber, messages: arrived };
      steers.push(steer);
    } catch (error) {
      opts.onError?.(error);
      return null;
    }
    await opts.onSteered?.(steer).catch((error: unknown) => opts.onError?.(error));
    return { messages: [...messages, ...added] };
  };
  return { preparer, steers };
}

/** Step starts in an answer's parts: one per step, the steps of earlier runs it continues included. */
export const stepStarts = (parts: UIMessage["parts"]) => parts.filter((p) => p.type === "step-start").length;

/**
 * The run's answer as it is stored: split before the first step after each steer. The first part keeps
 * the answer's id and `startedAt`; each later one gets a derived id (`<id>-2`, `<id>-3`) and a time just
 * after the messages it follows, so the conversation sorts as the model saw it. `baseSteps` counts the
 * step starts the answer already had (a run continuing it after approvals). A steer whose step has not
 * started yet in `message` splits nothing yet.
 */
export function answerSegments(
  message: UIMessage,
  startedAt: Date,
  steers: readonly Steer[],
  baseSteps = 0,
): StoredMessage[] {
  const starts = message.parts.flatMap((p, i) => (p.type === "step-start" ? [i] : []));
  const cuts: { at: number; createdAt: Date }[] = [];
  for (const steer of [...steers].sort((a, b) => a.step - b.step)) {
    const at = starts[baseSteps + steer.step];
    if (at === undefined) break;
    const last = Math.max(...steer.messages.map((m) => m.createdAt.getTime()));
    cuts.push({ at, createdAt: new Date(last + 1) });
  }
  if (!cuts.length) return [{ message, createdAt: startedAt }];
  const segments: StoredMessage[] = [
    { message: { ...message, parts: message.parts.slice(0, cuts[0]!.at) }, createdAt: startedAt },
  ];
  cuts.forEach((cut, i) =>
    segments.push({
      message: { ...message, id: `${message.id}-${i + 2}`, parts: message.parts.slice(cut.at, cuts[i + 1]?.at) },
      createdAt: cut.createdAt,
    }),
  );
  return segments;
}

/** Prefixes the first message the user wrote after an answer that was never sent to them (see holdStaleReply). */
export const UNDELIVERED_NOTE =
  "(Your previous answer above was not sent to the user because they wrote again meanwhile; answer everything in one reply.)";

const isUndelivered = (message: UIMessage | undefined) =>
  message?.role === "assistant" && (message.metadata as { undelivered?: unknown } | undefined)?.undelivered === true;

/**
 * The note on the user message after a held answer. It goes on that message, at the end of the history
 * when it is new, so the cached prefix and the instructions stay as they were; later runs replay it the same.
 */
export function withUndeliveredNotes(history: StoredMessage[]): StoredMessage[] {
  return history.map((stored, i) =>
    stored.message.role === "user" && isUndelivered(history[i - 1]?.message)
      ? {
          ...stored,
          message: { ...stored.message, parts: [{ type: "text", text: UNDELIVERED_NOTE }, ...stored.message.parts] },
        }
      : stored,
  );
}

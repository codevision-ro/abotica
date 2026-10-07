import type { ModelMessage, PrepareStepFunction, StepResult, ToolSet } from "ai";

/**
 * What runs before each step of a run. streamText takes one `prepareStep`, while several independent
 * parts of the runner change the step's prompt, so they go through this pipeline in a fixed order. Each
 * preparer gets the step with the messages as the preparers before it left them, and returns new
 * messages or nothing. streamText carries returned messages forward into the later steps, so a message
 * added once stays in the prompt: a preparer adds it once, not on every step.
 *
 * The runner orders them: messages from outside the run first (they are what the model answers), then
 * notices about the run itself (the loop nudge), and last whatever shortens the prompt, so that one sees
 * the prompt the model is going to get.
 */

/** The step about to run. */
export type StepInput = {
  /** 0 for the first step of the run. */
  stepNumber: number;
  /** The steps this run finished so far. */
  steps: StepResult<ToolSet>[];
  /** The prompt's messages, with the changes of the preparers before this one. */
  messages: ModelMessage[];
};

/** A preparer's change to the step: the messages that replace the prompt's, or nothing. */
export type StepChange = { messages: ModelMessage[] } | null | undefined;

export type StepPreparer = (step: StepInput) => StepChange | Promise<StepChange>;

/** Runs the preparers in order before each step; a step none of them changes keeps streamText's defaults. */
export function prepareSteps(preparers: StepPreparer[]): PrepareStepFunction<ToolSet> {
  return async ({ stepNumber, steps, messages }) => {
    let prepared = messages;
    for (const prepare of preparers) {
      const change = await prepare({ stepNumber, steps, messages: prepared });
      if (change) prepared = change.messages;
    }
    return prepared === messages ? undefined : { messages: prepared };
  };
}

/** Appends a user message to the prompt, for a preparer that has something to tell the model. */
export const withUserMessage = (messages: ModelMessage[], text: string): ModelMessage[] => [
  ...messages,
  { role: "user", content: text },
];

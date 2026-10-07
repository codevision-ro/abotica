import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { prepareSteps, type StepPreparer, withUserMessage } from "./step-preparation";

const prompt: ModelMessage[] = [{ role: "user", content: "Do the task" }];

/** The options streamText passes to prepareStep; the pipeline reads only these. */
const stepOptions = (messages = prompt) => ({ stepNumber: 2, steps: [], messages }) as never;

describe("prepareSteps", () => {
  it("leaves the step to streamText's defaults when no preparer changes it", async () => {
    const quiet: StepPreparer = () => null;
    expect(await prepareSteps([quiet, quiet])(stepOptions())).toBeUndefined();
  });

  it("runs the preparers in order, each on the messages the one before left", async () => {
    const seen: string[][] = [];
    const adding =
      (text: string): StepPreparer =>
      ({ messages }) => {
        seen.push(messages.map((m) => String(m.content)));
        return { messages: withUserMessage(messages, text) };
      };

    const result = await prepareSteps([adding("first"), () => undefined, adding("second")])(stepOptions());

    expect(seen).toEqual([["Do the task"], ["Do the task", "first"]]);
    expect(result).toEqual({
      messages: [...prompt, { role: "user", content: "first" }, { role: "user", content: "second" }],
    });
  });

  it("passes each preparer the step it prepares", async () => {
    const preparer = vi.fn<StepPreparer>(() => null);
    await prepareSteps([preparer])(stepOptions());
    expect(preparer).toHaveBeenCalledWith({ stepNumber: 2, steps: [], messages: prompt });
  });

  it("waits for a preparer that works asynchronously", async () => {
    const slow: StepPreparer = async ({ messages }) => ({ messages: withUserMessage(messages, "later") });
    expect(await prepareSteps([slow])(stepOptions())).toEqual({ messages: withUserMessage(prompt, "later") });
  });
});

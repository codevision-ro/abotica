import "server-only";
import { getTranslator, isUserError, translateKey } from "@abotica/i18n";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { requireUser } from "./session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Wraps a server action with auth and input validation. Errors become { ok: false }
 * so client code can toast them instead of crashing the page.
 *
 * Messages reach the user translated: throw `new UserError("area.errors.key", values)` for
 * expected failures, and use full message keys as zod messages (`z.string().min(1, "area.validation.key")`).
 * A refinement's `params` are the message's values (`.refine(fn, { message, params: { max } })`).
 */
export function action<S extends z.ZodType, T>(
  schema: S,
  handler: (input: z.output<S>, user: Awaited<ReturnType<typeof requireUser>>) => Promise<T>,
) {
  return async (input: z.input<S>): Promise<ActionResult<T>> => {
    const user = await requireUser();
    const t = getTranslator(await getLocale());
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) =>
        translateKey(t, issue.message, "params" in issue ? (issue.params as Record<string, string | number>) : undefined),
      );
      return { ok: false, error: [...new Set(messages)].join("\n") };
    }
    try {
      return { ok: true, data: await handler(parsed.data, user) };
    } catch (error) {
      if (error instanceof Error && "digest" in error) throw error; // let redirect()/notFound() through
      if (isUserError(error)) return { ok: false, error: translateKey(t, error.key, error.values) };
      // Unexpected errors can carry internals (a failed query's SQL and parameters): logged here, never sent.
      console.error(error);
      return { ok: false, error: t("errors.unknown") };
    }
  };
}

import { tool } from "ai";
import { z } from "zod";
import { htmlToText } from "../../memory/knowledge";
import { readTextCapped, safeFetch } from "../../platform/safe-fetch";
import { errorResult, type ToolFactory } from "./shared";

const MAX_CHARS = 20_000;
/** Most of a page's bytes are markup; this leaves room for well over MAX_CHARS of text. */
const MAX_BYTES = 2 * 1024 * 1024;

export const webTools: Record<string, ToolFactory> = {
  web_fetch: () =>
    tool({
      description: "Fetch a web page and return its text (max ~20k characters).",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }, { abortSignal }) => {
        try {
          const res = await safeFetch(url, {
            signal: abortSignal,
            headers: { "user-agent": "Mozilla/5.0 (compatible; AboticaBot/1.0)" },
          });
          const type = res.headers.get("content-type") ?? "";
          const body = await readTextCapped(res, MAX_BYTES);
          const text = type.includes("html") ? htmlToText(body.text) : body.text;
          return {
            status: res.status,
            url: res.url,
            content: text.slice(0, MAX_CHARS),
            truncated: body.truncated || text.length > MAX_CHARS,
          };
        } catch (error) {
          // A cancelled run still stops; refused addresses, network errors and timeouts go back to the model.
          if (abortSignal?.aborted) throw error;
          return errorResult(error);
        }
      },
    }),
};

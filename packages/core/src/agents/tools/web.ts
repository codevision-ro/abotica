import { tool } from "ai";
import { z } from "zod";
import { htmlToText } from "../../memory/knowledge";
import { readTextCapped, safeFetch } from "../../platform/safe-fetch";
import { capToolText, fullOutputTarget, TOOL_TEXT_MAX_CHARS } from "../tool-output";
import { wrapUntrusted } from "../untrusted";
import { markerId } from "../untrusted-id";
import { errorResult, type ToolFactory } from "./shared";

/** Most of a page's bytes are markup; this leaves room for well over TOOL_TEXT_MAX_CHARS of text. */
const MAX_BYTES = 2 * 1024 * 1024;

export const webTools: Record<string, ToolFactory> = {
  web_fetch: (ctx) =>
    tool({
      description: `Fetch a web page and return its text (max ~${TOOL_TEXT_MAX_CHARS / 1000}k characters; a long page keeps its start and end).`,
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }, call) => {
        const { abortSignal } = call;
        try {
          const res = await safeFetch(url, {
            signal: abortSignal,
            headers: { "user-agent": "Mozilla/5.0 (compatible; AboticaBot/1.0)" },
          });
          const type = res.headers.get("content-type") ?? "";
          const body = await readTextCapped(res, MAX_BYTES);
          const text = type.includes("html") ? htmlToText(body.text) : body.text;
          const workspace = ctx.sandbox && { sandbox: ctx.sandbox, runId: ctx.run.id };
          const content = await capToolText(text, fullOutputTarget(workspace, call));
          return {
            status: res.status,
            url: res.url,
            content: content.text,
            truncated: body.truncated || content.cut !== null,
          };
        } catch (error) {
          // A cancelled run still stops; refused addresses, network errors and timeouts go back to the model.
          if (abortSignal?.aborted) throw error;
          return errorResult(error);
        }
      },
      // The page goes to the model as untrusted data; the stored result keeps it as it came.
      toModelOutput: ({ toolCallId, output }) => {
        if (!("content" in output)) return { type: "json", value: output };
        ctx.untrustedSeen = true;
        return {
          type: "json",
          value: { ...output, content: wrapUntrusted(output.content, { source: "web", id: markerId(toolCallId) }) },
        };
      },
    }),
};

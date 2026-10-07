import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { filePath } from "@abotica/core";
import { getTranslations } from "next-intl/server";
import { isUuid } from "@/lib/uuid";
import { getStoredFile } from "@/server/queries/files";
import { requireApiUser } from "@/server/session";

/** A stored file: an upload, a task attachment, a knowledge file or a file an agent shared. */
export async function GET(_req: Request, ctx: RouteContext<"/api/files/[id]">) {
  try {
    await requireApiUser();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const { id } = await ctx.params;
  const row = isUuid(id) ? await getStoredFile(id) : null;
  if (!row) return new Response("Not found", { status: 404 });

  const file = filePath(row.id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    const t = await getTranslations("files.errors");
    return new Response(t("missingOnDisk"), { status: 410 });
  }

  // Streamed from disk: a file can be up to 50 MB and is never read into memory whole.
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  // Always a download, never rendered as a page: the content may come from an agent. <img> previews still work.
  return new Response(body, {
    headers: {
      "Content-Type": row.mimeType,
      "Content-Length": String(info.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Pages of other origins (agents' previews on subdomains) cannot embed the user's files.
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
